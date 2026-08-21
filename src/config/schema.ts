// @ref LLP 0006#root-vs-scope-config — schema for root vs. scope-overridable config keys
// @ref LLP 0006#auth-config-shapes — auth union schema (legacy single credential + per-provider map)
// @ref LLP 0006#routing-manifest — routing.jsonc manifest schema (scopes, budgets, traversal guard)
// @ref LLP 0006#budgets-and-chunking-defaults — chunk/budget default values and re-tuning heuristics
import path from "node:path";

import { z } from "zod";

import { CATEGORIES } from "../core/schema.js";
import type { Category } from "../core/schema.js";

export const ReviewConfigSchema = z.object({
  /** Default model for every agent + the coordinator. Override per-agent via
   * frontmatter in the agent's markdown, or globally via REVIEWER_MODEL. */
  model: z.string().default("openai/gpt-5.5"),
  policy: z
    .object({
      includeSuggestions: z.boolean().default(false),
      maxFindings: z.number().int().positive().optional(),
    })
    .default({ includeSuggestions: false }),
  chunk: z
    .object({
      // Chunking is bounded by changed lines (added + removed), not file count —
      // "how much code the model must actually reason about" is what dilutes
      // attention, and 20 one-line tweaks are nothing like 3 files of 800 lines.
      //
      // A diff whose total changed lines fit in one chunk is reviewed in a single
      // full-context pass (no chunking, no cross-cutting overhead). Larger diffs
      // split into focused chunks, plus a cross-cutting pass for diff-spanning
      // issues.
      //
      // Why 1000: it's a heuristic, not a measured optimum. Most real PRs change
      // well under ~1000 lines, so they get a single full-context pass and skip
      // chunking; only genuinely large PRs split. It also keeps each chunk small
      // enough that the reasoning-heavy correctness agent finishes within its time
      // cap — on real 50-file PRs a 1500-line chunk pushed correctness past 15 min,
      // so smaller/more chunks (each finishing faster, run in parallel) beat fewer/
      // larger ones. Coupled to `model`.
      //
      // When to tweak:
      //  - LOWER it if passes hit their time cap on large PRs, if the reviewer
      //    misses issues, or if you use a cheaper/smaller/faster model.
      //  - RAISE it to cut the number of passes when the model handles big diffs
      //    well and passes finish comfortably within their caps.
      //  - Re-tune from real-PR data (cap-hit rate + false-negative rate), not guesses.
      maxChangedLines: z.number().int().positive().default(1000),
      // Secondary guard so a chunk isn't an absurd number of tiny-diff files.
      maxFiles: z.number().int().positive().default(20),
      // Max concurrent reviewer calls across all agents/chunks. Unset ⇒ resolved
      // from the auth mode: 6 for API-key runs, 3 when a subscription (oauth)
      // credential is configured — one ChatGPT account handles six parallel
      // streams poorly (requests get parked = the stall signature), and several
      // PRs may be reviewing on the same credential at once. An explicit value
      // here always wins. See effectiveConcurrency in core/review.ts.
      concurrency: z.number().int().positive().optional(),
    })
    .default({ maxChangedLines: 1000, maxFiles: 20 }),
  noise: z
    .object({
      additionalIgnores: z.array(z.string()).default([]),
      additionalMarkers: z.array(z.string()).default([]),
    })
    .default({ additionalIgnores: [], additionalMarkers: [] }),
  research: z
    .object({
      enabled: z.boolean().default(false),
      // Removed with the offline index. An unknown key would be stripped silently,
      // so name it explicitly: a config carrying it is stale, and quietly ignoring
      // the setting is worse than refusing to start.
      indexPath: z
        .never({
          error:
            "research.indexPath was removed — documentation is now always fetched live from the provider allowlist. Delete this key.",
        })
        .optional(),
      maxQueries: z.number().int().min(1).max(20).default(8),
      resultsPerQuery: z.number().int().min(1).max(3).default(2),
      // One search may spend up to ~10s on discovery plus sequential bounded page
      // fetches (~10s each), so the per-call budget must exceed that worst case —
      // 15s cut off healthy slow searches on the OpenCode engine.
      timeoutMs: z.number().int().min(1000).max(60_000).default(30_000),
    })
    .default({
      enabled: false,
      maxQueries: 8,
      resultsPerQuery: 2,
      timeoutMs: 30_000,
    }),
  breakGlass: z
    .object({ marker: z.string().default("/skip-review") })
    .default({ marker: "/skip-review" }),
  commentTag: z.string().default("expo-ai-code-reviewer"),
  // Two accepted shapes (see AuthConfigEntry for the canonical internal form):
  //  - legacy single credential: { mode, provider, tokenEnv }
  //  - per-provider map:         { providers: { <id>: { mode, tokenEnv, upstream? } } }
  // The map form allows a MIXED setup — e.g. the "openai" provider on a ChatGPT/Codex
  // subscription (mode "oauth", tokenEnv = the refresh token) plus an "openai-api"
  // alias (upstream "openai") holding a metered API key for pro-tier models the
  // subscription doesn't offer.
  //
  // Union order matters: the map form must be tried FIRST — the legacy object's keys
  // all have defaults, so a non-strict legacy parse would accept (and gut) a
  // { providers } object by stripping the unknown key.
  // @ref LLP 0006#auth-config-shapes [constrained-by] — map-first order is load-bearing; reordering silently guts multi-provider auth
  auth: z
    .union([
      z.object({
        providers: z.record(
          z.string(),
          z.object({
            // "api-key": tokenEnv holds the provider's API key.
            // "oauth": tokenEnv holds an OAuth token, injected into an isolated
            // OpenCode auth.json. For "openai" this is the REFRESH token from a
            // ChatGPT/Codex sign-in (OpenCode's codex plugin mints access tokens
            // from it).
            // NOTE: provider "anthropic" is ALWAYS served by the Claude Code CLI
            // (the engine is inferred from the `anthropic/…` model, not this mode) —
            // for anthropic, mode is irrelevant; tokenEnv optionally names the
            // credential env (an "sk-ant-oat…" subscription token or an Anthropic
            // API key), and no entry at all falls back to the machine's `claude`
            // login. See core/claude-code.ts.
            mode: z.enum(["api-key", "oauth"]).default("api-key"),
            tokenEnv: z.string().optional(),
            // Set ⇒ this provider id is an ALIAS synthesized into the OpenCode
            // config, backed by the named upstream's SDK ("openai", "anthropic",
            // anything else = openai-compatible). Lets one upstream be reached
            // with two credentials at once (subscription + API key).
            upstream: z.string().optional(),
          }),
        ),
      }),
      z.object({
        mode: z.enum(["api-key", "oauth"]).default("api-key"),
        provider: z.string().default("openai"),
        /** Env var holding the key/token. */
        tokenEnv: z.string().optional(),
      }),
    ])
    .default({ mode: "api-key", provider: "openai" }),
  review: z
    .object({
      // Which PRs `ecr ci` acts on — the source of truth for trigger policy (a
      // workflow `if:` gate, if any, is an optional coarse filter layered on top):
      //   "all"   — review every PR, unless it carries the `skipLabel`.
      //   "label" — review only PRs carrying `label` (e.g. `ai-review`) or a
      //             `label:<agent>` variant. `skipLabel` still wins.
      trigger: z.enum(["all", "label"]).default("all"),
      // Opt-in label (and prefix for `label:<agent>`) used when trigger is "label".
      label: z.string().default("ai-review"),
      // Opt a single PR out of review. A label (not a config flag) because labels
      // are write-gated to maintainers — a PR author can't add one to dodge review.
      skipLabel: z.string().default("ai-review:skip"),
    })
    .default({ trigger: "all", label: "ai-review", skipLabel: "ai-review:skip" }),
  // Stack-aware requalification: walk the OPEN PRs stacked on top of this one and
  // let the coordinator mark absence-style findings a later PR already addresses.
  // ROOT-ONLY (one PR has one stack) and off by default — a suppression-adjacent
  // feature earns trust with field data first. Under `ecr ci` it auto-enables from
  // this trusted-base value; `ecr review --pr` needs an explicit --stack-aware.
  // @ref LLP 0010#config-and-cli-surface [implements] — root-only + off-by-default; head config can never enable, widen, or disable it
  stack: z
    .object({
      enabled: z.boolean().default(false),
      maxDepth: z.number().int().positive().default(4),
      // Children per level (per parent branch) the walk will follow.
      maxPrs: z.number().int().positive().default(8),
      maxFilesPerPr: z.number().int().positive().default(100),
      // Only children whose author is the current PR's author enter the manifest —
      // closes cross-author poisoning (a push-access colleague opening a child PR on
      // the victim's branch). Set false from the trusted base for genuine team stacks.
      requireSameAuthor: z.boolean().default(true),
      // v2: confirm each requalification against the addressing PR's actual patch
      // before believing it (a no-tools LLM reads the inlined patch). Default false so
      // v2 ships dark until flipped; maxConfirmations bounds that cost.
      confirmWithPatch: z.boolean().default(false),
      maxConfirmations: z.number().int().positive().default(10),
    })
    .default({
      enabled: false,
      maxDepth: 4,
      maxPrs: 8,
      maxFilesPerPr: 100,
      requireSameAuthor: true,
      confirmWithPatch: false,
      maxConfirmations: 10,
    }),
  // Author replies to findings: match them to the finding they answer, record
  // them in the comment's embedded state, and (optionally) let a model judge the
  // rebuttal against the source. ROOT-ONLY: the comment lifecycle is global.
  // Defaults are deliberately ASYMMETRIC: `annotate` is on but `dismiss` is off.
  // An adopting repo has its own config.jsonc and never re-copies this template,
  // so a key it never set must still resolve to the safe, useful default via
  // zod — annotating is safe and useful out of the box; suppressing a finding is
  // not, so it stays opt-in.
  // @ref LLP 0011#asymmetric-defaults [implements] — annotate on, dismiss off; adopting repos never re-copy the template
  feedback: z
    .object({
      // "off"        — ignore replies entirely.
      // "annotate"   — match + record + show "author replied" (no decision effect).
      // "adjudicate" — also run a source-grounded judgment of the rebuttal and
      //                record its verdict. Dismissal still obeys `dismiss`.
      mode: z.enum(["off", "annotate", "adjudicate"]).default("annotate"),
      // How a reply is MATCHED to a finding. Clearing one additionally requires the
      // reply to cite its `id:` token in the replier's own words, whatever this says.
      match: z.enum(["quote", "id", "both"]).default("both"),
      // Who/what may actually remove a finding from the blocking set (always on a
      // reply citing the finding's `id:` token — a quote only annotates):
      //   "never"       — nothing does (default: adjudication ships dark).
      //   "maintainers" — a maintainer reply dismisses, no model involved.
      //   "adjudicated" — a maintainer reply, or an author reply the adjudicator
      //                   confirmed against the source.
      dismiss: z.enum(["never", "maintainers", "adjudicated"]).default("never"),
      // Categories a reply can NEVER clear, whatever the verdict. Also hard-coded
      // as a floor in code — this only widens the set, never narrows it.
      protectedCategories: z.array(z.enum(CATEGORIES)).default(["secrets", "security"]),
      // Cap on adjudication model calls per run.
      maxAdjudications: z.number().int().positive().default(10),
    })
    .default({
      mode: "annotate",
      match: "both",
      dismiss: "never",
      protectedCategories: ["secrets", "security"],
      maxAdjudications: 10,
    }),
  // Inline PR review comments for findings anchored to a line in the diff: the
  // main comment stays the durable state store and renders such findings short,
  // linking to the inline thread. ROOT-ONLY (the comment lifecycle is global) and
  // off by default — a feature that mutates N comments per run earns trust with
  // field data first. Turning it off later leaves existing threads up (documented);
  // clear() still sweeps them on comment-mode switches.
  inline: z
    .object({
      enabled: z.boolean().default(false),
      // Cap on inline comments PER REPORTER: per PR in single/legacy comment mode,
      // per scope in per-scope mode. Bounds create-notification fan-out and API use.
      maxComments: z.number().int().positive().default(20),
    })
    .default({ enabled: false, maxComments: 20 }),
});
export type RawReviewConfig = z.infer<typeof ReviewConfigSchema>;

/** One routing scope: ordered globs → a directory containing .expo-code-review/. */
export const RoutingScopeSchema = z.object({
  /** Kebab-case id; used in comments, fingerprint namespacing, --scopes. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "scope name must be kebab-case"),
  /** Ordered globs (same dialect as noise.additionalIgnores: ** and *). */
  paths: z.array(z.string().min(1)).min(1),
  /** Repo-relative dir whose .expo-code-review/ holds the scope's config ('.' = root).
   * routing.jsonc is read from the PR-head checkout, so this field is
   * PR-controllable input: absolute paths and `..` traversal are rejected so a
   * scope config can never resolve outside the repo. */
  // @ref LLP 0006#routing-manifest [implements] — traversal guard; load.ts re-checks at runtime (defense in depth)
  config: z
    .string()
    .min(1)
    .refine(
      (value) => !path.isAbsolute(value) && !path.normalize(value).split(/[/\\]/).includes(".."),
      { message: 'scope config must be a repo-relative path without ".." segments' },
    ),
});

export const RoutingManifestSchema = z
  .object({
    /** How N scopes render on one PR. */
    comment: z.enum(["single", "per-scope"]).default("single"),
    /** Wall-clock budget for the per-scope review passes. Active scopes run
     * SEQUENTIALLY in one `ecr ci` process, so the total is divided across them
     * (not spent per scope). Absent = today's totals (zod defaults). */
    budget: z
      .object({
        /** Total passes budget (minutes) split across active scopes. Sized to fit
         * the scaffolded workflow's `timeout-minutes` (90) with margin for the
         * coordinator (10m), verification, and git/gh overhead. The cross-file pass
         * expands to fill whatever of this window is left (see review.ts), so this
         * is the knob that decides how long it may trace. */
        totalPassesMinutes: z.number().int().positive().default(55),
        /** Per-scope floor (minutes): below this a scope review isn't worth
         * starting, so the even split clamps up to it — even when that makes the
         * scopes overshoot the total (ecr ci warns; doctor flags the worst case). */
        minScopeMinutes: z.number().int().positive().default(5),
      })
      .default({ totalPassesMinutes: 55, minScopeMinutes: 5 }),
    defaults: z
      .object({
        /** The ONLY manifest-level place auth is honored (locks the root value).
         * Unwrap the inner `.default()` first: in zod v4 a `.default().optional()`
         * chain still fires the default when the key is absent, which would make
         * `defaults.auth` a phantom `{mode:'api-key',provider:'openai'}` for every
         * manifest that omits auth and silently override the root config's real auth. */
        // @ref LLP 0006#routing-manifest [constrained-by] — zod v4 default().optional() trap; unwrap avoids a phantom auth stub
        auth: ReviewConfigSchema.shape.auth.unwrap().optional(),
        /** Agent ids injected into every scope with alwaysRun, from the ROOT roster. */
        enforceAgents: z.array(z.string()).default([]),
        /** Root comment marker; per-scope tags derive from it. */
        commentTag: z.string().default("expo-ai-code-reviewer"),
      })
      .default({ enforceAgents: [], commentTag: "expo-ai-code-reviewer" }),
    /** Ordered; LAST matching scope wins per changed file (CODEOWNERS discipline). */
    scopes: z.array(RoutingScopeSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    // unique scope names; unique config dirs (after path.normalize).
    const seenNames = new Set<string>();
    for (const scope of manifest.scopes) {
      if (seenNames.has(scope.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate scope name: ${scope.name}`,
          path: ["scopes"],
        });
      }
      seenNames.add(scope.name);
    }
    const seenDirs = new Map<string, string>();
    for (const scope of manifest.scopes) {
      const norm = path.normalize(scope.config).replace(/[/\\]+$/, "");
      if (seenDirs.has(norm)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate scope config dir: ${scope.config} (already used by scope "${seenDirs.get(norm)}")`,
          path: ["scopes"],
        });
      }
      seenDirs.set(norm, scope.name);
    }
  });
export type RoutingManifest = z.infer<typeof RoutingManifestSchema>;
export type RoutingScope = z.infer<typeof RoutingScopeSchema>;
export type RoutingDefaults = RoutingManifest["defaults"];

/**
 * Scope config = root config MINUS the centrally locked keys. Allowlist of
 * scope-overridable keys (Turborepo-style, graft 6): model, policy, chunk,
 * noise (+ the prompt files living beside it: shared.md, coordinator.md,
 * agents/). NEVER auth, breakGlass, or research — declaring one fails parsing at the
 * Zod level so IDE/doctor catch it before CI. commentTag is also locked: a
 * scope's comment marker is always DERIVED (`<rootTag>:<scope>`; the default
 * scope keeps the root tag) so `ecr ci`'s post/clear/reconcile paths and a
 * standalone `ecr review --scope --post` always target the same marker — an
 * honored per-scope tag would let the two halves strand each other's comments.
 */
// @ref LLP 0006#root-vs-scope-config [implements] — one of three enforcement layers; z.never fails at parse, not runtime
export const ScopeReviewConfigSchema = ReviewConfigSchema.omit({
  auth: true,
  breakGlass: true,
  commentTag: true,
  stack: true,
  feedback: true,
  research: true,
  inline: true,
}).extend({
  auth: z
    .never({ error: "auth is locked to the root config; remove it from this scope config" })
    .optional(),
  breakGlass: z.never({ error: "breakGlass is locked to the root config" }).optional(),
  commentTag: z
    .never({
      error:
        "commentTag is locked: per-scope comment markers are derived as <rootTag>:<scope>; remove it from this scope config",
    })
    .optional(),
  stack: z
    .never({
      error:
        "stack is locked to the root config (one PR has one stack); remove it from this scope config",
    })
    .optional(),
  feedback: z
    .never({
      error:
        "feedback is locked to the root config (the comment lifecycle is global); remove it from this scope config",
    })
    .optional(),
  research: z
    .never({
      error:
        "research is locked to the root config because it starts a trusted host process; remove it from this scope config",
    })
    .optional(),
  inline: z
    .never({
      error:
        "inline is locked to the root config (the comment lifecycle is global); remove it from this scope config",
    })
    .optional(),
});
export type RawScopeReviewConfig = z.infer<typeof ScopeReviewConfigSchema>;

/** A single agent after prompt files are read and models are resolved. */
export interface LoadedAgent {
  id: string;
  /** One-line summary from frontmatter, used by the router to pick agents. */
  description: string;
  /** Frontmatter `alwaysRun: true` — router always includes it (e.g. security). */
  alwaysRun: boolean;
  model: string;
  temperature: number;
  tools: Record<string, boolean>;
  /** Role prompt text (not including the shared prompt). */
  promptText: string;
}

/**
 * One provider credential, canonical internal form (both config shapes normalize
 * to a list of these — see normalizeAuth in load.ts).
 */
export interface AuthConfigEntry {
  provider: string;
  /**
   * How this credential is supplied to OpenCode ("api-key" or "oauth"). IRRELEVANT
   * for provider "anthropic": an `anthropic/…` model is always served by the Claude
   * Code CLI (engine inferred from the model), which reads the credential from
   * tokenEnv or the machine's `claude` login regardless of this field.
   */
  mode: "api-key" | "oauth";
  /**
   * Env var holding the credential. api-key: the key itself. oauth: the token —
   * for provider "openai" this is the REFRESH token from a ChatGPT/Codex sign-in
   * (access tokens live ~1h, shorter than a worst-case run, so the refresh token
   * is the durable secret and OpenCode's codex plugin mints access tokens from it).
   */
  tokenEnv?: string;
  /**
   * Set ⇒ this provider id is an alias synthesized into the OpenCode config,
   * backed by the named upstream's SDK. Used to reach one upstream with a second
   * credential (e.g. "openai-api" upstream "openai" for pro-tier models billed to
   * an API key, while "openai" itself runs on the subscription).
   */
  upstream?: string;
}

/** Fully-resolved config: prompt files read, models resolved, defaults applied. */
export interface LoadedConfig {
  configDir: string;
  sharedPromptText: string;
  agents: LoadedAgent[];
  coordinator: {
    model: string;
    temperature: number;
    promptText: string;
  };
  policy: {
    includeSuggestions: boolean;
    maxFindings?: number;
  };
  chunk: {
    maxChangedLines: number;
    maxFiles: number;
    /** Unset ⇒ resolved by effectiveConcurrency (auth-mode-aware default). */
    concurrency?: number;
  };
  noise: {
    additionalIgnores: string[];
    additionalMarkers: string[];
  };
  /** Root-only configuration for the bundled, bounded documentation MCP. */
  research: {
    enabled: boolean;
    maxQueries: number;
    resultsPerQuery: number;
    timeoutMs: number;
  };
  breakGlassMarker: string;
  commentTag: string;
  /** Every configured provider credential (one entry for the legacy single shape). */
  auth: AuthConfigEntry[];
  review: {
    trigger: "all" | "label";
    label: string;
    skipLabel: string;
  };
  /** Root-only stack-aware requalification settings (see ReviewConfigSchema.stack). */
  stack: {
    enabled: boolean;
    maxDepth: number;
    maxPrs: number;
    maxFilesPerPr: number;
    requireSameAuthor: boolean;
    confirmWithPatch: boolean;
    maxConfirmations: number;
  };
  /** Root-only author-feedback settings (see ReviewConfigSchema.feedback). */
  feedback: {
    mode: "off" | "annotate" | "adjudicate";
    match: "quote" | "id" | "both";
    dismiss: "never" | "maintainers" | "adjudicated";
    protectedCategories: Category[];
    maxAdjudications: number;
  };
  /** Root-only inline-comment settings (see ReviewConfigSchema.inline). */
  inline: {
    enabled: boolean;
    maxComments: number;
  };
}
