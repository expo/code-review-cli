// @ref LLP 0006#loading-and-the-config-dir-escape-hatch — shared root/scope loader; ECR_CONFIG_DIR escape hatch
// @ref LLP 0006#model-resolution — REVIEWER_MODEL env override resolution
// @ref LLP 0006#auth-config-shapes — auth normalization (normalizeAuth, tokenEnvMismatch, loadAuthFromRoot)
// @ref LLP 0006#root-vs-scope-config — scope config loading, commentTag derivation, enforceAgents injection
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { DEFAULT_MIN_SEVERITY, ReviewConfigSchema, ScopeReviewConfigSchema } from "./schema.js";
import type { AuthConfigEntry } from "./schema.js";
import type {
  LoadedAgent,
  LoadedConfig,
  RawReviewConfig,
  RoutingManifest,
  RoutingScope,
} from "./schema.js";
import { toolMap } from "../core/tools.js";

/**
 * The setup directory. `.expo-agents/code-review/` is the home from 0.15.0 —
 * one `.expo-agents/` directory holds every Expo agent tool's per-repo files
 * (code-review, verify) instead of one dot directory per tool at the root.
 * The pre-0.15 `.expo-code-review/` keeps working unchanged: every lookup
 * takes whichever of the two exists (new first), and scaffolding writes into
 * an existing legacy directory rather than starting a second one.
 */
export const CONFIG_DIRNAME = path.join(".expo-agents", "code-review");
export const LEGACY_CONFIG_DIRNAME = ".expo-code-review";
export const CONFIG_DIRNAMES: readonly string[] = [CONFIG_DIRNAME, LEGACY_CONFIG_DIRNAME];

/** Does this directory path name a setup dir (either spelling)? */
export function isConfigDirPath(dir: string): boolean {
  const normalized = path.normalize(dir);
  return CONFIG_DIRNAMES.some(
    (name) => normalized === name || normalized.endsWith(path.sep + name),
  );
}

/** Stack config for a scope load (where `stack` is schema-rejected and absent). */
const STACK_CONFIG_DEFAULTS: LoadedConfig["stack"] = {
  enabled: false,
  maxDepth: 4,
  maxPrs: 8,
  maxFilesPerPr: 100,
  requireSameAuthor: true,
  confirmWithPatch: false,
  maxConfirmations: 10,
};

/** Feedback config for a scope load (where `feedback` is schema-rejected and absent). */
const FEEDBACK_CONFIG_DEFAULTS: LoadedConfig["feedback"] = {
  mode: "annotate",
  match: "both",
  dismiss: "never",
  protectedCategories: ["secrets", "security"],
  maxAdjudications: 10,
};

/** Inline-comment config for a scope load (where `inline` is schema-rejected). */
const INLINE_CONFIG_DEFAULTS: LoadedConfig["inline"] = {
  enabled: false,
  maxComments: 20,
};

/** Research defaults for a scope load (where `research` is schema-rejected). */
const RESEARCH_CONFIG_DEFAULTS: LoadedConfig["research"] = {
  enabled: false,
  maxQueries: 8,
  resultsPerQuery: 2,
  timeoutMs: 30_000,
};

/** Default OpenCode tool toggles for a reviewer: read the repo, never mutate it. */
const DEFAULT_AGENT_TOOLS = toolMap(["read", "grep", "glob", "list"]);

/**
 * The setup dir under `base`: `.expo-agents/code-review/` when it exists, else
 * the legacy `.expo-code-review/` when THAT exists, else the new name (for
 * messages and for scaffolding a fresh repo). Works for the repo root and for
 * scope directories alike.
 */
export function configDirFor(base: string): string {
  for (const name of CONFIG_DIRNAMES) {
    const candidate = path.join(base, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(base, CONFIG_DIRNAME);
}

/**
 * Resolve the config directory: an explicit override (absolute or repo-relative)
 * → the ECR_CONFIG_DIR env var → the repo's default setup dir (new name, then
 * legacy). This is the escape hatch (graft 1); with neither override present the
 * result is exactly `configDirFor(repoRoot)`.
 */
export function resolveConfigDir(repoRoot: string, override?: string): string {
  const chosen = override ?? process.env.ECR_CONFIG_DIR;
  if (chosen) {
    return path.isAbsolute(chosen) ? chosen : path.join(repoRoot, chosen);
  }
  return configDirFor(repoRoot);
}

export interface LoadConfigOptions {
  /** Explicit config dir (absolute or repo-relative). Overrides ECR_CONFIG_DIR. */
  configDir?: string;
}

/** Parsed config with the centrally-locked keys optional (scope configs omit them). */
type ParsedConfig = Omit<
  RawReviewConfig,
  "auth" | "breakGlass" | "commentTag" | "stack" | "feedback" | "research" | "inline"
> & {
  auth?: RawReviewConfig["auth"];
  breakGlass?: RawReviewConfig["breakGlass"];
  commentTag?: RawReviewConfig["commentTag"];
  stack?: RawReviewConfig["stack"];
  feedback?: RawReviewConfig["feedback"];
  research?: RawReviewConfig["research"];
  inline?: RawReviewConfig["inline"];
};

export function hasConfig(repoRoot: string, options: LoadConfigOptions = {}): boolean {
  // Resolve the same way loadReviewConfig does (incl. the ECR_CONFIG_DIR escape
  // hatch) so doctor's "no config" diagnostic never disagrees with the loader.
  const dir = resolveConfigDir(repoRoot, options.configDir);
  return existsSync(path.join(dir, "config.jsonc")) || existsSync(path.join(dir, "config.json"));
}

/**
 * Discover and fully resolve a repo's review config from `.expo-code-review/`:
 * parse config.jsonc, read every prompt file, and resolve models (with an
 * optional REVIEWER_MODEL env override applied to all agents + the coordinator).
 */
export async function loadReviewConfig(
  repoRoot: string,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const dir = resolveConfigDir(repoRoot, options.configDir);
  return (await loadConfigDir(dir, ReviewConfigSchema)).config;
}

/**
 * The shared per-directory loader: parse config.jsonc, read every prompt file,
 * resolve models. Root and scope loading share this one code path — the schema
 * argument controls whether the centrally-locked keys (auth/breakGlass) are
 * accepted (root) or rejected at the Zod level (scope). `loadReviewConfig` with
 * `ReviewConfigSchema` produces identical output for identical input.
 */
async function loadConfigDir(
  dir: string,
  schema: typeof ReviewConfigSchema | typeof ScopeReviewConfigSchema,
): Promise<{ config: LoadedConfig; raw: Record<string, unknown> }> {
  const configPath = ["config.jsonc", "config.json"]
    .map((name) => path.join(dir, name))
    .find((candidate) => existsSync(candidate));

  if (!configPath) {
    throw new Error(
      `No ${CONFIG_DIRNAME}/config.jsonc found in ${path.dirname(dir)}. Run \`ecr init\` to scaffold one.`,
    );
  }

  const raw = await readFile(configPath, "utf8");
  const rawObject = JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as Record<
    string,
    unknown
  >;
  const parsed = schema.parse(rawObject) as ParsedConfig;

  // An EMPTY REVIEWER_MODEL means "not set", not "use the empty model". GitHub Actions
  // passes `${{ vars.REVIEWER_MODEL }}` as an empty string whenever that repo variable
  // doesn't exist — which both scaffolded workflows do — so `??` (which only falls
  // through on null/undefined) silently replaced every configured model with "". Every
  // agent and the coordinator then ran on whatever OpenCode picked by default, so a
  // config saying `anthropic/claude-sonnet-5` reviewed with something else entirely and
  // nothing anywhere said so. Trim too: a stray newline is the same class of accident.
  // @ref LLP 0006#model-resolution [constrained-by] — never ??; GitHub Actions passes an unset var as empty string, not undefined
  const override = process.env.REVIEWER_MODEL?.trim() || undefined;
  const defaultModel = override ?? parsed.model;
  const resolveModel = (frontmatterModel?: string): string =>
    override ?? frontmatterModel ?? defaultModel;
  const resolveTemp = (value: string | undefined, fallback: number): number => {
    const n = value == null ? NaN : Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  // Frontmatter problems that loading reports instead of throwing: in CI a load error
  // stops every review in the repo, and nothing checks prompt files before they merge.
  const setupWarnings: string[] = [];
  const label = setupDirLabel(dir);
  const { policy, deprecation } = resolvePolicy(
    parsed.policy,
    path.join(label, path.basename(configPath)),
  );
  const readPrompt = async (file: string): Promise<ReturnType<typeof parseFrontmatter>> => {
    const raw = await readFile(path.join(dir, file), "utf8");
    const md = parseFrontmatter(raw);
    setupWarnings.push(...frontmatterWarnings(raw, md, path.join(label, file)));
    return md;
  };

  // shared.md is optional; the coordinator is required.
  const sharedPromptText = existsSync(path.join(dir, "shared.md"))
    ? (await readPrompt("shared.md")).body
    : "";

  if (!existsSync(path.join(dir, "coordinator.md"))) {
    throw new Error(`Missing ${CONFIG_DIRNAME}/coordinator.md`);
  }
  const coordinatorMd = await readPrompt("coordinator.md");

  // Every markdown file in agents/ is a reviewer agent (id = filename).
  const agentsDir = path.join(dir, "agents");
  if (!existsSync(agentsDir)) {
    throw new Error(`Missing ${CONFIG_DIRNAME}/agents/ directory. Run \`ecr init\`.`);
  }
  const agentFiles = (await readdir(agentsDir)).filter((name) => name.endsWith(".md")).sort();
  if (agentFiles.length === 0) {
    throw new Error(`No agent markdown files in ${CONFIG_DIRNAME}/agents/.`);
  }

  const agents: LoadedAgent[] = [];
  for (const file of agentFiles) {
    const md = await readPrompt(path.join("agents", file));
    const id = file.replace(/\.md$/, "");
    const { paths, warning } = parseAgentPaths(md, path.join(label, "agents", file));
    if (warning) {
      setupWarnings.push(warning);
    }
    agents.push({
      id,
      description: md.data.description ?? "",
      alwaysRun: /^(true|yes|1)$/i.test(md.data.alwaysRun ?? ""),
      model: resolveModel(md.data.model),
      temperature: resolveTemp(md.data.temperature, 0.1),
      tools: DEFAULT_AGENT_TOOLS,
      promptText: md.body,
      // Only when declared: an agent without `paths` keeps the exact shape (and
      // review-cache key) it had before the key existed.
      ...(paths ? { paths } : {}),
    });
  }

  const config: LoadedConfig = {
    configDir: dir,
    sharedPromptText,
    agents,
    // Only when there are any, so a clean setup keeps its review-cache key.
    ...(setupWarnings.length > 0 ? { setupWarnings } : {}),
    ...(deprecation ? { deprecations: [deprecation] } : {}),
    coordinator: {
      model: resolveModel(coordinatorMd.data.model),
      temperature: resolveTemp(coordinatorMd.data.temperature, 0),
      promptText: coordinatorMd.body,
    },
    policy,
    chunk: parsed.chunk,
    noise: parsed.noise,
    // Root-only: scope schemas reject research configuration, so an untrusted
    // subtree cannot select the index or alter the network-facing runtime.
    research: parsed.research ?? RESEARCH_CONFIG_DEFAULTS,
    // parsed.breakGlass/auth are always present for the root schema (defaults) and
    // absent for the scope schema; loadScopeConfig overrides both afterwards.
    breakGlassMarker: parsed.breakGlass?.marker ?? "/skip-review",
    // Scope configs can't declare commentTag (scope schema rejects it);
    // loadScopeConfig overwrites this placeholder with the manifest default.
    commentTag: parsed.commentTag ?? "expo-ai-code-reviewer",
    auth: normalizeAuth(parsed.auth),
    review: parsed.review,
    // Root-only: the scope schema rejects `stack`, so parsed.stack is absent for a
    // scope config and the defaults stand in (unused — the command layer reads the
    // ROOT config's stack values to drive the walk).
    stack: parsed.stack ?? STACK_CONFIG_DEFAULTS,
    // Root-only: the scope schema rejects `feedback`, so parsed.feedback is absent
    // for a scope config and the defaults stand in (unused — the command layer
    // reads the ROOT config's feedback values; the comment lifecycle is global).
    feedback: parsed.feedback ?? FEEDBACK_CONFIG_DEFAULTS,
    // Root-only, same reasoning as feedback.
    inline: parsed.inline ?? INLINE_CONFIG_DEFAULTS,
  };
  return { config, raw: rawObject };
}

/**
 * Normalize either accepted `auth` shape (legacy single object, or the
 * per-provider `{ providers }` map) into the canonical entry list. Absent auth
 * means the schema default (api-key/openai, no tokenEnv).
 */
export function normalizeAuth(
  auth:
    | { mode: "api-key" | "oauth"; provider: string; tokenEnv?: string }
    | {
        providers: Record<
          string,
          { mode: "api-key" | "oauth"; tokenEnv?: string; upstream?: string }
        >;
      }
    | undefined,
): AuthConfigEntry[] {
  if (!auth) {
    return [{ provider: "openai", mode: "api-key" }];
  }
  if ("providers" in auth) {
    return Object.entries(auth.providers).map(([provider, entry]) => ({
      provider,
      mode: entry.mode,
      tokenEnv: entry.tokenEnv,
      upstream: entry.upstream,
    }));
  }
  return [{ provider: auth.provider, mode: auth.mode, tokenEnv: auth.tokenEnv }];
}

/**
 * Runtime auth lock: null when the entries' tokenEnv names equal the expected
 * comma-separated set exactly (order-insensitive), else a human-readable
 * mismatch. Set semantics because a multi-provider auth block names several
 * credential envs — a PR must not be able to add, drop, or repoint any of them.
 */
export function tokenEnvMismatch(auth: AuthConfigEntry[], expected: string): string | null {
  const declared = [
    ...new Set(auth.map((entry) => entry.tokenEnv).filter((v): v is string => Boolean(v))),
  ].sort();
  const expectedSet = [
    ...new Set(
      expected
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort();
  if (JSON.stringify(declared) === JSON.stringify(expectedSet)) {
    return null;
  }
  return `configured tokenEnv set [${declared.join(", ") || "(none)"}] != ECR_EXPECTED_TOKEN_ENV [${expectedSet.join(", ")}]`;
}

/**
 * auth is honored ONLY here: the manifest's `defaults.auth` wins when present,
 * otherwise the root config.jsonc auth. A scope config can never contribute auth
 * (the scope schema rejects it), so the secret-forwarding surface stays a single,
 * root-owned value no matter how many scopes exist.
 */
export function loadAuthFromRoot(
  rootConfig: LoadedConfig,
  manifest: RoutingManifest | null,
): LoadedConfig["auth"] {
  const override = manifest?.defaults.auth;
  if (override) {
    return normalizeAuth(override);
  }
  return rootConfig.auth;
}

export interface LoadedScopeConfig extends LoadedConfig {
  scopeName: string;
}

/**
 * Whether a scope's own config dir exists under `root` — the same path
 * `loadScopeConfig` reads (deliberately NOT via resolveConfigDir: ECR_CONFIG_DIR
 * must never redirect scope subtrees). `ecr ci` uses this against the TRUSTED
 * BASE root to give scopes that are new in a PR a defined miss behavior (review
 * with the root config; the scope config activates after merge) instead of
 * failing the run on exactly the PR that introduces the scope.
 */
// @ref LLP 0006#loading-and-the-config-dir-escape-hatch [implements] — deliberately bypasses ECR_CONFIG_DIR; scope subtrees stay repo-root-relative
export function hasScopeConfig(root: string, scope: RoutingScope): boolean {
  if (scope.config === ".") {
    return true;
  }
  const dir = configDirFor(path.join(root, scope.config));
  return existsSync(path.join(dir, "config.jsonc")) || existsSync(path.join(dir, "config.json"));
}

/**
 * Load one scope's fully-resolved config. The default scope (config '.') reuses
 * the root config unchanged except auth; a nested scope reads its own
 * `.expo-code-review/` via the scope schema (auth/breakGlass rejected by Zod).
 * auth and breakGlass always come from the root; `defaults.enforceAgents` are
 * injected with alwaysRun and win any same-id agent in the scope roster (risk 11).
 */
export async function loadScopeConfig(
  root: string,
  scope: RoutingScope,
  manifest: RoutingManifest,
  rootConfig: LoadedConfig,
): Promise<LoadedScopeConfig> {
  let base: LoadedConfig;
  let commentTag: string;
  if (scope.config === ".") {
    base = rootConfig;
    // The default scope keeps the ROOT comment marker so the existing single
    // comment (and its dismissal state) upserts in place, not duplicated (risk 8).
    commentTag = rootConfig.commentTag;
  } else {
    // Defense in depth behind the schema's traversal refinement: never read a
    // scope config from outside the repo checkout (scope.config is PR-controllable).
    const resolvedRoot = path.resolve(root);
    const resolvedScope = path.resolve(root, scope.config);
    if (resolvedScope !== resolvedRoot && !resolvedScope.startsWith(resolvedRoot + path.sep)) {
      throw new Error(
        `scope "${scope.name}": config "${scope.config}" resolves outside the repo checkout`,
      );
    }
    const dir = configDirFor(path.join(root, scope.config));
    const { config } = await loadConfigDir(dir, ScopeReviewConfigSchema);
    base = config;
    // Non-default scopes never carry their own marker (the scope schema rejects
    // commentTag): ci derives `<rootTag>:<scope>` for per-scope comments, so the
    // loaded value here is only the manifest default, for display/doctor.
    commentTag = manifest.defaults.commentTag;
  }

  // @ref LLP 0006#root-vs-scope-config [implements] — ROOT enforced agent always wins a same-id scope agent (risk 11)
  // Inject the enforced agents from the ROOT roster with alwaysRun, replacing any
  // same-id agent the scope defines (the enforced one wins — risk 11).
  const agents: LoadedAgent[] = base.agents.map((agent) => ({ ...agent }));
  for (const id of manifest.defaults.enforceAgents) {
    const rootAgent = rootConfig.agents.find((agent) => agent.id === id);
    if (!rootAgent) {
      throw new Error(
        `defaults.enforceAgents lists "${id}", but the root roster has no agent with that id.`,
      );
    }
    const enforced: LoadedAgent = { ...rootAgent, alwaysRun: true };
    const index = agents.findIndex((agent) => agent.id === id);
    if (index >= 0) {
      agents[index] = enforced;
    } else {
      agents.push(enforced);
    }
  }

  return {
    ...base,
    agents,
    auth: loadAuthFromRoot(rootConfig, manifest),
    breakGlassMarker: rootConfig.breakGlassMarker,
    commentTag,
    // Root-only, like stack: a non-default scope's `base` carries only the
    // hardcoded placeholder (the scope schema rejects `feedback`), so re-derive
    // from the root here or consumers of a nested scope's config would silently
    // run the default policy instead of the repo's real one.
    stack: rootConfig.stack,
    feedback: rootConfig.feedback,
    inline: rootConfig.inline,
    research: rootConfig.research,
    scopeName: scope.name,
  };
}

/**
 * Parse optional YAML-ish frontmatter from the top of a markdown file. Returns
 * every `key: value` line as a scalar in `data`, the keys whose value is a list in
 * `lists`, and the body with frontmatter stripped. A list is either a flow list on
 * one line (`paths: ["a/**", "b/**"]`) or a block list (`paths:` followed by
 * `- item` lines). Supports per-agent overrides like `model:` and `paths:`.
 */
export function parseFrontmatter(md: string): {
  data: Record<string, string>;
  lists: Record<string, string[]>;
  body: string;
} {
  if (!md.startsWith("---")) {
    return { data: {}, lists: {}, body: md };
  }
  const end = md.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, lists: {}, body: md };
  }
  const header = md.slice(3, end).trim();
  const body = md.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  // The key with an empty value, whose following `- item` lines form its block list.
  // Blank and comment lines inside the list are skipped; the next key ends it.
  let blockKey: string | null = null;
  for (const line of header.split(/\r?\n/)) {
    const item = line.match(/^\s*-(.*)$/);
    if (blockKey && item) {
      const rest = item[1]!;
      // `-glob` with no space is not a YAML list item; keep the dash so validation
      // names it instead of the line silently dropping out of the list.
      (lists[blockKey] ??= []).push(/^\S/.test(rest) ? `-${rest.trim()}` : unquote(rest.trim()));
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      const key = match[1]!;
      const raw = match[2]!.trim();
      data[key] = raw.replace(/^["']|["']$/g, "");
      delete lists[key];
      const flow = parseFlowList(raw);
      if (flow) {
        lists[key] = flow;
      }
      blockKey = raw === "" ? key : null;
    }
  }
  return { data, lists, body };
}

/**
 * Strip the quotes around a whole quoted value. A value with text after its closing
 * quote (`"a/**" x`, `"a/**" "b/**"`) keeps them, so validation can name it.
 */
function unquote(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.indexOf(quote, 1) === value.length - 1
    ? value.slice(1, -1)
    : value;
}

/**
 * The items of a one-line flow list (`[a, "b", 'c']`), or null when `raw` is not
 * one. Items may be bare, single- or double-quoted; a trailing comma is allowed.
 */
function parseFlowList(raw: string): string[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    return null;
  }
  // Split at the commas outside quotes, keeping each item's quotes for unquote().
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of raw.slice(1, -1)) {
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) {
    // An unterminated quote: not a list the author can have meant.
    return null;
  }
  items.push(current.trim());
  if (items.length === 1 && items[0] === "") {
    return [];
  }
  // Allow one trailing comma, as JSONC config does.
  if (items.length > 1 && items[items.length - 1] === "") {
    items.pop();
  }
  return items.map(unquote);
}

/**
 * The agent's frontmatter `paths`. An absent key gives neither field. An invalid
 * value gives no `paths` either, so the agent reviews every change, plus a setup
 * warning that names `file` and the fix.
 */
function parseAgentPaths(
  md: { data: Record<string, string>; lists: Record<string, string[]> },
  file: string,
): { paths?: string[]; warning?: string } {
  if (!("paths" in md.data)) {
    return {};
  }
  // @ref LLP 0006#agent-frontmatter-and-paths [implements] — an invalid `paths` is a setup warning and the agent reviews every change; never a load error, never a silent no-match
  const issue = agentPathsIssue(md);
  if (issue) {
    return {
      warning:
        `${file}: \`paths\` ${issue.problem}, so the agent ignores it and reviews every ` +
        `change. Fix: ${issue.fix}, or remove \`paths\`.`,
    };
  }
  return { paths: md.lists.paths };
}

/** Why `paths` is not a non-empty list of globs that can match a changed file, or null. */
function agentPathsIssue(md: {
  data: Record<string, string>;
  lists: Record<string, string[]>;
}): { problem: string; fix: string } | null {
  const globs = md.lists.paths;
  if (!globs) {
    return TRAILING_COMMENT.test(md.data.paths ?? "")
      ? {
          problem: "has a `# comment` after it, which frontmatter does not strip",
          fix: "move the comment to its own line",
        }
      : {
          problem: "is not a list of globs",
          fix: 'write it as `paths: ["packages/app/**", ".changeset/*.md"]` or as `- "glob"` lines',
        };
  }
  if (globs.length === 0) {
    return { problem: "is empty", fix: "list at least one glob" };
  }
  for (const [index, glob] of globs.entries()) {
    const issue = pathGlobIssue(glob);
    if (issue) {
      return {
        problem: `entry ${index + 1} (${JSON.stringify(glob)}) ${issue.problem}`,
        fix: issue.fix,
      };
    }
  }
  return null;
}

/** A `#` that starts a YAML comment: at the start of a value or after whitespace. */
const TRAILING_COMMENT = /(?:^|\s)#/;

/** What a trailing `# comment` does to each scalar key whose value it breaks. */
const SCALAR_COMMENT_EFFECTS: ReadonlyArray<readonly [string, string]> = [
  ["alwaysRun", "so `alwaysRun` is off"],
  ["model", "so it is not a valid model id"],
  ["temperature", "so the default temperature applies"],
];

/**
 * The loaded policy, with the severity floor resolved. A config that still sets
 * `includeSuggestions` loads as before, plus a deprecation that names `file` and the fix.
 */
function resolvePolicy(
  parsed: RawReviewConfig["policy"],
  file: string,
): { policy: LoadedConfig["policy"]; deprecation?: string } {
  const { minSeverity, includeSuggestions, maxFindings } = parsed;
  const policy: LoadedConfig["policy"] = {
    minSeverity: minSeverity ?? (includeSuggestions ? "nit" : DEFAULT_MIN_SEVERITY),
    ...(maxFindings != null ? { maxFindings } : {}),
  };
  if (includeSuggestions == null) {
    return { policy };
  }
  const deprecation = minSeverity
    ? `${file}: \`policy.includeSuggestions\` has no effect because \`policy.minSeverity\` ` +
      "is set. Fix: remove `includeSuggestions`."
    : `${file}: \`policy.includeSuggestions\` is deprecated. Replace it with ` +
      `\`"minSeverity": "${policy.minSeverity}"\`.`;
  return { policy, deprecation };
}

/**
 * Setup warnings for one prompt file's frontmatter. Each names `file` and the fix.
 * They are reported (job log, PR comment, `ecr doctor`), never thrown: the file
 * loads exactly as it did before the check existed.
 */
function frontmatterWarnings(
  raw: string,
  md: { data: Record<string, string> },
  file: string,
): string[] {
  const hidden = hiddenFrontmatter(raw);
  if (hidden) {
    return [
      `${file}: its frontmatter does not start on the first line (${hidden.cause}), so ` +
        "every key in it is ignored, including `description`, `alwaysRun`, `model` and " +
        `\`paths\`. Fix: ${hidden.fix}.`,
    ];
  }
  const warnings: string[] = [];
  for (const [key, effect] of SCALAR_COMMENT_EFFECTS) {
    const value = md.data[key];
    if (value !== undefined && TRAILING_COMMENT.test(value)) {
      warnings.push(
        `${file}: \`${key}: ${value}\` keeps its trailing \`# comment\` as part of the ` +
          `value, ${effect}. Fix: move the comment to its own line.`,
      );
    }
  }
  return warnings;
}

/**
 * Why a file's frontmatter sits below its first byte, where parseFrontmatter does
 * not look, or null when it does not. The scaffolded templates once opened with an
 * `@ref` HTML comment above the `---`, and repos scaffolded then still do.
 */
function hiddenFrontmatter(raw: string): { cause: string; fix: string } | null {
  if (raw.startsWith("---")) {
    return null;
  }
  // `\s` also matches a byte-order mark.
  const lead = raw.match(/^(?:\s+|<!--[\s\S]*?-->)+/)?.[0];
  if (!lead || Object.keys(parseFrontmatter(raw.slice(lead.length)).data).length === 0) {
    return null;
  }
  if (lead.startsWith("﻿")) {
    return {
      cause: "the file starts with a byte-order mark",
      fix: "save it as UTF-8 without a byte-order mark",
    };
  }
  if (lead.includes("<!--")) {
    return {
      cause: "an HTML comment comes first",
      fix: "move the comment below the closing `---`",
    };
  }
  return { cause: "blank lines come first", fix: "delete the lines above the opening `---`" };
}

/** Why a `paths` glob can never match a repo-relative changed file, or null when it can. */
function pathGlobIssue(glob: string): { problem: string; fix: string } | null {
  if (glob.trim() === "") {
    return { problem: "is empty", fix: "delete the entry" };
  }
  const comment = glob.search(TRAILING_COMMENT);
  if (comment !== -1) {
    const value = unquote(glob.slice(0, comment).trim());
    return {
      problem: 'contains a "# comment", which frontmatter does not strip',
      fix: value
        ? `write ${JSON.stringify(value)} and move the comment to its own line`
        : "move the comment to its own line",
    };
  }
  if (/^["']/.test(glob)) {
    // unquote() leaves the quotes when text follows the closing one.
    return {
      problem: "has text after its closing quote, or no closing quote",
      fix: "quote the whole glob, and separate entries with commas",
    };
  }
  if (/^-\S/.test(glob)) {
    return {
      problem: 'starts with "-" and no space, so YAML would not read it as a list item',
      fix: `write "- ${glob.slice(1)}"`,
    };
  }
  if (/\{[^{}]*,[^{}]*\}/.test(glob)) {
    return {
      problem: 'uses a "{a,b}" brace set, but agent `paths` match braces literally',
      fix: "list each alternative as its own entry",
    };
  }
  if (glob.split("{").length !== glob.split("}").length) {
    return {
      problem: 'has an unmatched "{" or "}", as an unquoted "{a,b}" splits at its comma',
      fix: "list each alternative as its own quoted entry",
    };
  }
  if (glob.startsWith("/")) {
    return {
      problem: "is absolute, but changed files are repo-relative",
      fix: `write ${JSON.stringify(glob.replace(/^\/+/, ""))}`,
    };
  }
  if (glob.startsWith("./")) {
    return {
      problem: 'starts with "./", but changed files are repo-relative without it',
      fix: `write ${JSON.stringify(glob.replace(/^(\.\/)+/, ""))}`,
    };
  }
  if (glob.endsWith("/")) {
    return {
      problem: 'ends with "/", so it matches no file',
      fix: `write ${JSON.stringify(`${glob}**`)} to match the files under it`,
    };
  }
  if (glob.startsWith("!")) {
    return {
      problem: 'uses "!" negation, which agent `paths` do not support',
      fix: "list only the paths the agent should review",
    };
  }
  return null;
}

/** The setup dir as error messages name it: its conventional name, else its basename. */
function setupDirLabel(dir: string): string {
  const normalized = path.normalize(dir);
  return (
    CONFIG_DIRNAMES.find((name) => normalized === name || normalized.endsWith(path.sep + name)) ??
    path.basename(dir)
  );
}

/**
 * Strip // line and /* *\/ block comments from JSONC, ignoring anything inside
 * string literals. The config is trusted (in-repo), so a light scanner suffices.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += input[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (char === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += char;
    }
  }
  return out;
}

/** Remove trailing commas before `}`/`]` (JSONC), ignoring string contents. */
export function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += input[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) {
        j++;
      }
      if (input[j] === "}" || input[j] === "]") {
        continue; // drop the trailing comma
      }
    }
    out += char;
  }
  return out;
}
