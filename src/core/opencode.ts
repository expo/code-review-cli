// @ref LLP 0003#opencode-server-lifecycle [implements] — OpenCode server startup, CLI/SDK pinning, model preflight
// @ref LLP 0003#retry-taxonomy [implements] — stall/timeout/backoff handling for OpenCode passes
import { createRequire } from "node:module";
import path from "node:path";

import { createOpencode } from "@opencode-ai/sdk";

import type { LoadedConfig } from "../config/schema.js";
// Type-only: erased at compile time, so it creates NO runtime import cycle. The
// Claude engine is reached at runtime via dynamic import() in the dispatch
// branches below; claude-code.ts statically imports the shared helpers here.
import type { ClaudeCodeHandle, Engine } from "./claude-code.js";
import { pathInside, resolveOnPath } from "./exec.js";
import { RateLimitWatch } from "./throttle.js";
import { toolMap } from "./tools.js";
import { errorMessage, sleep } from "./util.js";

/** Discriminant for the Claude Code CLI engine (see core/claude-code.ts). */
export const CLAUDE_CODE_ENGINE = "claude-code" as const;

/**
 * Resolve which engine an agent's pass dispatches to, and (when claude) which
 * claude handle to run it against. The per-agent router (engineOf) wins; absent it
 * the carrier's own single `engine` decides. When the pass is claude-routed the
 * claude handle is the carrier itself (a claude-only run, where the carrier IS the
 * claude handle) or its `.claude` field (any run that also drives OpenCode). Pure
 * and side-effect-free so the seam's dispatch is unit-testable without spawning.
 */
// @ref LLP 0003#two-engines-per-agent-dispatch [implements] — dynamic-import seam that reaches claude-code.ts at runtime, avoiding a static import cycle
export function resolveEngineDispatch(
  handle: OpencodeHandle,
  agent: string,
): { engine: "opencode" } | { engine: "claude-code"; claudeHandle: ClaudeCodeHandle } {
  const engine = handle.engineOf?.(agent) ?? handle.engine ?? "opencode";
  if (engine !== CLAUDE_CODE_ENGINE) {
    return { engine };
  }
  // A claude-only run: the carrier itself IS the claude handle. Cast is safe (and
  // still needed) because `handle` is typed OpencodeHandle here regardless.
  if (handle.engine === CLAUDE_CODE_ENGINE) {
    return { engine, claudeHandle: handle as ClaudeCodeHandle };
  }
  // Mixed run: engineOf routed this agent to claude-code, so the carrier's `.claude`
  // field must be set. If it isn't, that's an invariant violation in how the handle
  // was assembled, not a runtime fluke — fail loudly here instead of letting a bad
  // cast smuggle `undefined` past the type checker and crash deep inside
  // runClaudePrompt with no clue what went wrong.
  if (!handle.claude) {
    throw new Error(
      `Agent "${agent}" is routed to the claude-code engine but this handle has no ` +
        `.claude carrier — the handle was assembled inconsistently.`,
    );
  }
  return { engine, claudeHandle: handle.claude };
}

export interface OpencodeHandle {
  client: any;
  url: string;
  close: () => void;
  /** Rate-limit evidence from this server's own log (see core/throttle.ts). */
  rateLimit: RateLimitWatch;
  /** Which review engine this handle drives. undefined ⇒ the OpenCode engine
   * (default); "claude-code" ⇒ the Claude Code CLI engine, a superset handle
   * (see ClaudeCodeHandle) that the seam functions dispatch to. */
  engine?: Engine;
  /** Present on the carrier when the run ALSO drives the Claude Code engine: the
   * real claude handle, used by the per-agent dispatch below when engineOf routes an
   * agent to claude-code and the carrier itself is the opencode handle. */
  claude?: ClaudeCodeHandle;
  /** Per-agent engine router; undefined ⇒ single-engine run keyed by `engine`. */
  engineOf?: (agent: string) => Engine;
}

/** Token usage as reported on an OpenCode assistant message's `info.tokens`. */
export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface PromptResult {
  text: string;
  cost: number;
  sessionID: string;
  /** True when this reply came from the finalize ("wrap up now") path — i.e. the
   * agent ran out of time and returned partial findings rather than converging. */
  truncated?: boolean;
  /** Token usage for the model request that produced this reply (for cache metrics). */
  tokens?: TokenUsage;
  /**
   * The provider/model that ACTUALLY answered, as reported by the server — not what
   * was configured. OpenCode silently substitutes a default when an agent's model id
   * is empty or unusable, so without this a run can review with a completely different
   * model than the config names and nothing says so. (It did: an empty REVIEWER_MODEL
   * wiped every configured id and reviews ran on whatever provider happened to be
   * available.) Undefined when the server didn't report it.
   */
  model?: string;
}

/** Sum token usage across attempts (for per-task/run totals). */
export function addTokenUsage(into: TokenUsage, from?: TokenUsage): TokenUsage {
  if (!from) {
    return into;
  }
  into.input = (into.input ?? 0) + (from.input ?? 0);
  into.output = (into.output ?? 0) + (from.output ?? 0);
  into.reasoning = (into.reasoning ?? 0) + (from.reasoning ?? 0);
  into.cache = {
    read: (into.cache?.read ?? 0) + (from.cache?.read ?? 0),
    write: (into.cache?.write ?? 0) + (from.cache?.write ?? 0),
  };
  return into;
}

// The coordinator consolidates findings; it needs no repo tools.
const COORDINATOR_TOOLS = toolMap([]);
// Every tool disabled, passed per-REQUEST (not per-agent) to make a "reply now,
// don't investigate" prompt physically unable to call tools. A prompt-level plea is
// not enough: in eas-cli#4084 the finalize ("stop and return what you have") reply
// opened 7 more files and then blew its window, losing the whole pass.
const NO_TOOLS = toolMap([]);
// Agent id for the single combined cross-cutting pass (see review.ts). It MUST be
// defined here so OpenCode uses this restricted tool set — otherwise the model
// falls back to a default agent with full tools and crawls the whole repo, which
// is why the cross-file pass used to wander for its entire time budget.
export const CROSS_CUTTING_AGENT = "cross-cutting";
// Deliberately NO `glob`/`list`: the cross-file pass is given the changed files'
// patch paths already, and directory crawling is exactly what made it wander into
// unrelated packages. `read` (open a known file) + `grep` (find a cross-reference
// among the changed files) are enough to trace interactions.
const CROSS_CUTTING_TOOLS = toolMap(["read", "grep"]);

// Verifies a finding by re-reading the actual file (adversarial refute pass). Same
// restricted tool set — it opens the cited file and checks the claim.
export const VERIFIER_AGENT = "verifier";
const VERIFIER_TOOLS = toolMap(["read", "grep"]);

// @ref LLP 0010#patch-level-confirmation-v2 [implements] — no-tools agent: the addressing PR's patch is INLINED, never read from disk, so there is no pathInside surface at all
// Confirms a requalification by reading the addressing PR's INLINED patch (v2). It
// gets NO tools: the patch is inlined into the task, so it must never read the disk
// (the untrusted upstack tree is not even materialized) — an empty tool set makes
// that structural, like the coordinator.
export const STACK_VERIFIER_AGENT = "stack-verifier";

/** Build the inline OpenCode config (agents + coordinator) from a repo config. */
export function buildOpencodeConfig(config: LoadedConfig): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  for (const reviewer of config.agents) {
    agent[reviewer.id] = {
      description: `${reviewer.id} reviewer`,
      mode: "all",
      model: reviewer.model,
      temperature: reviewer.temperature,
      prompt: `You are the ${reviewer.id} code reviewer. Follow the user message exactly and return only the requested JSON.`,
      tools: reviewer.tools,
    };
  }
  agent[CROSS_CUTTING_AGENT] = {
    description: "Cross-file reviewer: issues spanning multiple changed files.",
    mode: "all",
    // Use the default reviewing model (agents share it unless overridden).
    model: config.agents[0]?.model ?? config.coordinator.model,
    temperature: config.agents[0]?.temperature ?? 0.1,
    prompt:
      "You are the cross-file code reviewer. Follow the user message exactly and return only the requested JSON.",
    tools: CROSS_CUTTING_TOOLS,
  };
  agent[VERIFIER_AGENT] = {
    description: "Verifies a finding against the real file (adversarial refute pass).",
    mode: "all",
    model: config.agents[0]?.model ?? config.coordinator.model,
    temperature: config.agents[0]?.temperature ?? 0.1,
    prompt:
      "You verify code-review findings against the actual source. Follow the user message exactly and return only the requested JSON.",
    tools: VERIFIER_TOOLS,
  };
  agent[STACK_VERIFIER_AGENT] = {
    description: "Confirms a requalification against the addressing PR's inlined patch.",
    mode: "all",
    model: config.agents[0]?.model ?? config.coordinator.model,
    temperature: config.agents[0]?.temperature ?? 0.1,
    prompt:
      "You judge whether a later PR's patch actually addresses a code-review finding. Follow the user message exactly and return only the requested JSON.",
    // No tools: the patch is inlined, so it must never read the disk (mirrors NO_TOOLS
    // on the coordinator — see STACK_VERIFIER_AGENT).
    tools: NO_TOOLS,
  };
  agent["coordinator"] = {
    description: "Consolidates specialist findings into one decision.",
    mode: "all",
    model: config.coordinator.model,
    temperature: config.coordinator.temperature,
    prompt:
      "You are the review coordinator. Follow the user message exactly and return only the requested JSON.",
    tools: COORDINATOR_TOOLS,
  };

  // Synthesize a provider block for each upstream-alias auth entry, so one
  // upstream can be reached with two credentials at once (e.g. "openai" on a
  // ChatGPT/Codex subscription for the default models, plus an "openai-api"
  // alias holding a metered API key for pro-tier models the subscription
  // doesn't offer). The alias's model list is exactly the ids the roster
  // references under that provider — OpenCode needs custom providers' models
  // declared, and declaring only what's used keeps the preflight meaningful.
  const provider: Record<string, unknown> = {};
  const referencedModels = [
    ...config.agents.map((reviewer) => reviewer.model),
    config.coordinator.model,
  ];
  for (const entry of config.auth) {
    if (!entry.upstream || !entry.tokenEnv) {
      continue;
    }
    const models: Record<string, unknown> = {};
    for (const id of referencedModels) {
      const slash = id.indexOf("/");
      if (slash > 0 && id.slice(0, slash) === entry.provider) {
        models[id.slice(slash + 1)] = {};
      }
    }
    provider[entry.provider] = {
      npm:
        entry.upstream === "openai"
          ? "@ai-sdk/openai"
          : entry.upstream === "anthropic"
            ? "@ai-sdk/anthropic"
            : "@ai-sdk/openai-compatible",
      name: entry.provider,
      options: { apiKey: `{env:${entry.tokenEnv}}` },
      models,
    };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    agent,
    ...(Object.keys(provider).length > 0 ? { provider } : {}),
  };
}

/** hey-api style responses come back as { data, error }; unwrap or throw. */
function unwrap<T>(res: any): T {
  if (res && typeof res === "object" && ("data" in res || "error" in res)) {
    if (res.error) {
      throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error));
    }
    return res.data as T;
  }
  return res as T;
}

/**
 * Directory holding the `opencode` binary from OUR dependency tree, or null if it
 * can't be resolved.
 *
 * The SDK spawns the server with a bare `launch("opencode", …)`, i.e. whatever comes
 * first on PATH. That silently couples every run to the machine's global install:
 * in CI, `npx -p @expo/code-review-cli` puts the temp prefix's `.bin` first and the
 * pinned version wins, but on a developer machine an older global `opencode` shadows
 * it and the pair drifts (a 1.18.1 CLI against a 1.18.4 SDK surfaced as
 * `ProviderModelNotFoundError: Model not found: anthropic/claude-opus-4-8` — the CLI
 * resolving a model id the SDK considered valid). Prepending this directory to PATH
 * makes the version we declare in package.json the version we actually run.
 */
function bundledOpencodeBinDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // <…>/node_modules/opencode-ai/package.json → <…>/node_modules/.bin, which holds
    // the correctly-named `opencode` shim (the package's own bin file is
    // `opencode.exe`, so the package dir itself is NOT a usable PATH entry).
    const pkg = require.resolve("opencode-ai/package.json");
    return path.join(path.dirname(pkg), "..", ".bin");
  } catch {
    return null;
  }
}

/** The `opencode` the SDK will actually spawn: ours if resolvable, else PATH's. */
export function opencodeBinSource(): { dir: string | null; pinned: boolean } {
  const dir = bundledOpencodeBinDir();
  return { dir, pinned: dir !== null };
}

/**
 * Resolve the `opencode` binary the way we trust it: OUR bundled shim when the
 * dependency resolves, else a PATH lookup from a trusted cwd (resolveOnPath, never
 * the inherited one) with a refusal of any binary that resolves INSIDE the current
 * tree. Null when unresolved or in-tree.
 *
 * `ecr doctor`/`ecr setup-auth` may run inside a cloned untrusted repo, so a bare
 * `opencode` handed to execFile/spawn resolves against the inherited cwd — and Windows
 * checks the current directory before PATH, letting a PR-committed `opencode` shim run
 * with ambient secrets in its env. Every opencode spawn in those commands goes through
 * this, mirroring resolveClaudeCli for the `claude` binary.
 */
export async function resolveOpencodeCli(): Promise<string | null> {
  const bundled = bundledOpencodeBinDir();
  if (bundled) {
    // Our own dependency tree (require.resolve is relative to THIS module, not cwd), so
    // it's trusted by construction — and NO in-tree refusal here: ecr's node_modules
    // commonly sits under cwd when run from its own repo, which pathInside would then
    // wrongly reject.
    return path.join(bundled, "opencode");
  }
  // PATH fallback: resolved from a trusted cwd, and refused if it lands in-tree.
  const cliPath = await resolveOnPath("opencode");
  if (!cliPath || pathInside(cliPath, process.cwd())) {
    return null;
  }
  return cliPath;
}

// @ref LLP 0003#opencode-server-lifecycle [constrained-by] — port 0 avoids clobbering a dev's already-running opencode session; the SDK's own bare launch("opencode") spawn is a knowingly accepted POSIX-only residual, not to be silently "fixed" into an absolute-path reimplementation
/** Start an in-process OpenCode server with the given inline config. */
export async function startOpencode(config: unknown): Promise<OpencodeHandle> {
  // Make our pinned CLI win over any global install (see bundledOpencodeBinDir).
  // The SDK takes no `env`, so PATH is the only lever; it spreads `process.env` at
  // spawn time, so setting it here reaches the child.
  //
  // SECURITY residual (accepted, POSIX-only deployment): the SDK spawns a BARE
  // `opencode` (cross-spawn `launch("opencode")`), which on Windows resolves the name
  // against the current directory before PATH — during a review the cwd is the
  // untrusted PR-head tree, so a PR-committed `opencode.exe` at its root could run in
  // its place. We deliberately do NOT reimplement the SDK's server bootstrap to inject
  // an absolute path here: on POSIX (the supported platform) `execvp` never searches
  // the cwd, so the hijack cannot fire, and forking the launch would mean silently
  // maintaining our own copy of it against SDK drift. The direct-spawn `opencode`
  // callers we own (`ecr doctor`/`ecr setup-auth`) are still hardened via
  // resolveOpencodeCli. Revisit if Windows becomes a supported target.
  const binDir = bundledOpencodeBinDir();
  if (binDir) {
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    // Port 0 = let the OS pick a free one. The SDK defaults to a FIXED 4096 and reads
    // the real URL back from the server's startup line, so the default meant any
    // already-running opencode (a developer's own session is the common case) made
    // every local run die with an opaque `ServeError`.
    port: 0,
    config: config as any,
  });
  // Watch THIS server's log for provider throttle evidence (prepareAuth has already
  // pointed XDG_DATA_HOME at the run's isolated dir when auth is injected).
  return { client, url: server.url, close: () => server.close(), rateLimit: new RateLimitWatch() };
}

/**
 * A configured `provider/model` string that the running server can't resolve, with
 * the closest ids it does know — the whole point is that the error names the fix.
 */
export interface UnknownModel {
  model: string;
  /**
   * `credential` — the provider is the one we supplied a credential for, and the
   * server still doesn't offer it: the credential was rejected, which is a very
   * different fix from a typo'd id (and the one that actually bit us: a bad
   * ANTHROPIC_OAUTH_API_KEY made every anthropic model look nonexistent).
   * `provider` — no such provider at all. `model` — provider fine, model isn't.
   */
  reason: "credential" | "provider" | "model";
  suggestions: string[];
}

/** `provider/model` as the server reported it, or undefined if it reported neither. */
export function formatModel(providerID?: string, modelID?: string): string | undefined {
  if (!providerID && !modelID) {
    return undefined;
  }
  return `${providerID ?? "?"}/${modelID ?? "?"}`;
}

/** Providers the server actually has, as `{ providerID: [modelID, …] }`. */
export type ProviderModels = Record<string, string[]>;

/**
 * Check configured model ids against what the server can resolve. Pure so the
 * matching rules are testable without a live server.
 *
 * A wrong model id is a CONFIG error: it hits every pass identically, no retry or
 * smaller scope can fix it, and the run should say so once instead of reporting N
 * indistinguishable "pass failed" gaps (or, worse, burning the whole budget first).
 */
export function findUnknownModels(
  models: string[],
  available: ProviderModels,
  /** Provider(s) we supplied a credential for, if any (see reason: "credential"). */
  credentialedProvider?: string | string[],
): UnknownModel[] {
  const credentialed = new Set(
    typeof credentialedProvider === "string"
      ? [credentialedProvider]
      : (credentialedProvider ?? []),
  );
  const unknown: UnknownModel[] = [];
  for (const model of new Set(models)) {
    // OpenCode model ids are `provider/model`; a model id may itself contain slashes
    // (e.g. openrouter's `vendor/name`), so only the FIRST segment is the provider.
    const slash = model.indexOf("/");
    const providerID = slash === -1 ? model : model.slice(0, slash);
    const modelID = slash === -1 ? "" : model.slice(slash + 1);
    const providerModels = available[providerID];
    if (!providerModels) {
      unknown.push({
        model,
        // We configured this provider's credential and the server still doesn't
        // offer it ⇒ the credential was refused, not the provider misnamed.
        reason: credentialed.has(providerID) ? "credential" : "provider",
        suggestions: Object.keys(available).sort(),
      });
      continue;
    }
    if (!providerModels.includes(modelID)) {
      // Suggest ids that share a prefix with what was asked for, else the whole list.
      const stem = modelID.split(/[-/]/)[0] ?? "";
      const near = stem ? providerModels.filter((id) => id.startsWith(stem)) : [];
      unknown.push({
        model,
        reason: "model",
        suggestions: (near.length > 0 ? near : providerModels).slice(0, 8).sort(),
      });
    }
  }
  return unknown;
}

/** Ask the running server which providers/models it can resolve. */
export async function fetchProviderModels(handle: OpencodeHandle): Promise<ProviderModels> {
  const data = unwrap<{ providers?: Array<{ id?: string; models?: Record<string, unknown> }> }>(
    await handle.client.config.providers(),
  );
  const available: ProviderModels = {};
  for (const provider of data?.providers ?? []) {
    if (provider?.id) {
      available[provider.id] = Object.keys(provider.models ?? {});
    }
  }
  return available;
}

/** Human-readable, copy-pasteable explanation of unresolvable model ids. */
export function formatUnknownModels(
  unknown: UnknownModel[],
  auths?:
    | { mode: string; provider: string; tokenEnv?: string }
    | Array<{ mode: string; provider: string; tokenEnv?: string }>,
): string {
  // A refused credential is one fact about the run, not one per model: report it once
  // and name the token to check, rather than repeating it for every configured model.
  const refused = unknown.filter((entry) => entry.reason === "credential");
  if (refused.length > 0) {
    const refusedProvider = refused[0]!.model.split("/")[0];
    const entries = auths ? (Array.isArray(auths) ? auths : [auths]) : [];
    const auth = entries.find((entry) => entry.provider === refusedProvider) ?? entries[0];
    const provider = auth?.provider ?? refusedProvider;
    const tokenEnv = auth?.tokenEnv;
    // Do NOT blame the token alone: the most common causes have nothing to do with
    // the credential's validity (see below). An earlier version of this message sent
    // us to re-issue two perfectly good tokens.
    // No anthropic special case here anymore: anthropic models never reach the
    // OpenCode preflight (engineForModel routes every anthropic/… id to the Claude
    // Code engine), so this message only ever names non-anthropic providers.
    return (
      `The OpenCode server does not offer the "${provider}" provider, even though this run ` +
      `supplied a ${auth?.mode ?? "configured"} credential for it. OpenCode drops a provider whose ` +
      `credential it could not use, which makes every ${provider} model look nonexistent: ` +
      `${refused.map((entry) => entry.model).join(", ")}.\n` +
      `The credential itself is often FINE. Check these in order:\n` +
      (tokenEnv
        ? `  1. The credential is wrong for the mode. ` +
          `auth.mode "api-key" expects a plain API key for ${provider}; an OAuth/subscription ` +
          `token is not an API key. A truncated or half-pasted ${tokenEnv} fails the same way.\n`
        : `  1. The credential is wrong for the configured auth.mode.\n`) +
      `Providers the server does offer: ${refused[0]!.suggestions.join(", ") || "(none)"}.`
    );
  }
  const lines = unknown.map((entry) =>
    entry.reason === "provider"
      ? `  ${entry.model} — unknown provider "${entry.model.split("/")[0]}". Configured providers: ${entry.suggestions.join(", ") || "(none — is the credential set?)"}`
      : `  ${entry.model} — that provider has no such model. Close matches: ${entry.suggestions.join(", ") || "(none)"}`,
  );
  return (
    `The configured model id(s) do not exist on the running OpenCode server:\n${lines.join("\n")}\n` +
    `Fix the model in .expo-code-review/config.jsonc (agents' \`model\`, \`coordinator.model\`) ` +
    `or REVIEWER_MODEL. Note that a model id must be "provider/model" (e.g. anthropic/claude-sonnet-5), ` +
    `and that an out-of-date \`opencode\` can reject an id a newer one accepts — run \`ecr doctor\`.`
  );
}

// @ref LLP 0003#opencode-server-lifecycle [implements] — fail once before any pass runs; distinguishes credential-refused from model-not-found (see UnknownModel.reason)
/**
 * Fail fast when a configured model can't be resolved, BEFORE any pass runs. Never
 * blocks the run on its own failure: if the providers endpoint can't be read (an
 * older server, a transport blip), the review proceeds and any real problem surfaces
 * per-pass as before.
 */
export async function assertModelsResolvable(
  handle: OpencodeHandle,
  models: string[],
  auths?: Array<{ mode: string; provider: string; tokenEnv?: string }>,
): Promise<void> {
  if (handle.engine === CLAUDE_CODE_ENGINE) {
    const { assertClaudeModels } = await import("./claude-code.js");
    return assertClaudeModels(handle as ClaudeCodeHandle, models);
  }
  let available: ProviderModels;
  try {
    available = await fetchProviderModels(handle);
  } catch {
    return;
  }
  if (Object.keys(available).length === 0) {
    return;
  }
  const unknown = findUnknownModels(
    models,
    available,
    auths?.map((entry) => entry.provider),
  );
  if (unknown.length > 0) {
    throw new Error(formatUnknownModels(unknown, auths));
  }
}

const POLL_INTERVAL_MS = 1000;
// Emit a "still working" heartbeat if this long passes with no tool activity, so
// a long model-thinking stretch doesn't look hung in the logs.
const HEARTBEAT_MS = 45_000;
// Default per-attempt ceiling. Focused chunk passes finish well under this; the
// cross-cutting pass is given more (see review.ts). Hitting the cap does NOT mean
// "retry" — we first interrupt the run and ask the agent to return whatever
// findings it already has (finalizeOnTimeout), and only fail if that also runs
// over. Callers must treat AgentTimeoutError as "abandon", never "retry".
const DEFAULT_MAX_WAIT_MS = 8 * 60 * 1000;
// Extra budget for the "stop and summarize what you have" finalization prompt.
// Deliberately generous: this is the ONLY chance to salvage a pass that ran out of
// time, and at 90s it was losing that race. Tools are disabled for the request
// (NO_TOOLS), so the reply is a single emit and normally lands in seconds.
const FINALIZE_WAIT_MS = 3 * 60 * 1000;

// ---- stall detection ----
//
// A pass is STALLED when its in-progress assistant message stops changing at all:
// no new tool call, no streamed text or reasoning, no token growth. A model that is
// genuinely thinking still grows that message every few seconds, so a gap this long
// means the provider request is wedged (or stuck in an internal retry we cannot
// see) — not that the work is hard.
//
// Motivating incident (eas-cli#4084, 2026-07-26): the cross-file pass ran 7 `read`
// calls in its first 6 seconds and then sat completely silent for 25 minutes,
// recording ZERO tokens (input, output, reasoning and cache all 0 in the run log),
// until its wall-clock cap fired. The finalize salvage then also went silent, so the
// pass's entire work product was lost and the PR got a coverage gap. Nothing in the
// run distinguished "wedged" from "thinking" — the heartbeat just printed elapsed
// seconds. A wall-clock cap alone cannot fix this: raising it only buys a longer
// silence, which is why the cap is NOT the lever here.
//
// Unlike the wall-clock cap (non-convergence → abandon, never retry), a stall is
// transient, so it earns ONE clean-slate retry inside the pass's existing budget.
const STALL_MS = 4 * 60 * 1000;
// Never let the watchdog outlast the pass it guards: a short pass (the 3m verifier,
// a 4m no-tools fallback) would otherwise hit its deadline before the watchdog could
// fire, and get none of this protection. Half the cap, with a floor that leaves room
// for a slow first token.
const MIN_STALL_MS = 30 * 1000;
// @ref LLP 0003#retry-taxonomy [constrained-by] — watchdog window capped at half the pass's own maxWaitMs so it can never outlast the deadline it protects
/** Exported for tests. */
export function stallWindowMs(maxWaitMs: number): number {
  return Math.min(STALL_MS, Math.max(MIN_STALL_MS, Math.floor(maxWaitMs / 2)));
}
// The finalize reply does no investigation and cannot call tools, so it should
// stream within seconds; a much shorter silence already means wedged.
const FINALIZE_STALL_MS = 60 * 1000;
// Breathing room before the retry: if the silence came from provider-side throttling
// or backoff, reconnecting instantly is the worst move.
const STALL_RETRY_BACKOFF_MS = 20 * 1000;
// When the account is provably rate-limited, wait in longer beats: re-sending the
// pass's whole context into a throttled account only deepens the limit. Several
// waits fit inside a pass budget, and each is long enough for a limit window to move.
const RATE_LIMIT_WAIT_MS = 90 * 1000;
// Only retry when enough of the pass's budget remains for the fresh attempt to
// plausibly finish; otherwise go straight to the soft landing.
const STALL_RETRY_MIN_REMAINING_MS = STALL_MS + 60 * 1000;

/**
 * What to do about a stalled attempt: WAIT (the account is provably rate-limited —
 * see core/throttle.ts — so patience beats re-sending the context; waits don't
 * consume the one retry), start over from a clean session, or stop and salvage
 * findings. Exactly ONE wedged retry, and only with enough budget left for it to
 * land — a second wedged attempt would just spend the rest of the pass's window,
 * which is the failure this whole mechanism exists to end. Exported for tests.
 */
export function stallAction(
  wedgedRetries: number,
  remainingMs: number,
  rateLimited = false,
): "wait" | "retry" | "soft-land" {
  if (rateLimited && remainingMs > STALL_RETRY_MIN_REMAINING_MS) {
    return "wait";
  }
  return wedgedRetries === 0 && remainingMs > STALL_RETRY_MIN_REMAINING_MS ? "retry" : "soft-land";
}

const FINALIZE_PROMPT =
  "You have reached your time budget. STOP investigating now — do NOT read, grep, " +
  "glob, list, or open any more files, and do not call any tools. Based ONLY on " +
  "what you have already examined, reply with the single JSON object exactly as " +
  "specified in your instructions, containing whatever findings you are already " +
  "confident about. If you have nothing solid, return an empty findings array.";

/**
 * Internal signal that a poll loop passed its deadline. Carries the best-effort
 * cost/tokens of the in-progress (never-completed) assistant message so a
 * timed-out task's spend isn't dropped from the run's metrics.
 */
class DeadlineReached extends Error {
  constructor(
    readonly cost: number = 0,
    readonly tokens?: TokenUsage,
  ) {
    super("deadline reached");
  }
}

/**
 * Internal signal that an in-progress reply went silent (see STALL_MS). Distinct
 * from DeadlineReached: the pass's time budget is NOT spent, so the caller can spend
 * what's left on a fresh attempt instead of abandoning the work.
 */
class NoProgress extends Error {
  constructor(
    readonly cost: number = 0,
    readonly tokens?: TokenUsage,
    /** How long the reply had been unchanged when we gave up on it. */
    readonly idleMs: number = 0,
  ) {
    super("no progress");
  }
}

/**
 * A cheap signature of how far along an in-progress reply is: its parts (count,
 * type, streamed length, tool status) plus the message's token/cost counters. ANY
 * real progress — a new tool call, another chunk of text or reasoning, a tool
 * advancing pending → running → completed — changes it; a wedged request leaves it
 * byte-identical poll after poll. Exported for tests.
 */
export function progressFingerprint(message: RawMessage): string {
  const shape = (message.parts ?? [])
    .map((part) => `${part.type ?? ""}:${(part.text ?? "").length}:${part.state?.status ?? ""}`)
    .join("|");
  const tokens = message.info?.tokens;
  return [
    shape,
    tokens?.input ?? 0,
    tokens?.output ?? 0,
    tokens?.reasoning ?? 0,
    tokens?.cache?.read ?? 0,
    tokens?.cache?.write ?? 0,
    message.info?.cost ?? 0,
  ].join("~");
}

const DEADLINE_SENTINEL = Symbol("deadline");

/**
 * Race a promise against the poll deadline. Without this, a stalled message fetch
 * (a wedged/overloaded OpenCode server) blocks the poll loop past its deadline,
 * because the deadline is only re-checked at the top of the loop — so a single
 * hung fetch could let a task run minutes past its time cap. Returns the sentinel
 * the instant the deadline passes, so the loop enforces the cap even mid-fetch.
 */
async function raceDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T | typeof DEADLINE_SENTINEL> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return DEADLINE_SENTINEL;
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof DEADLINE_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_SENTINEL), remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Thrown when an agent exceeds its time budget even after being asked to wrap up.
 * Callers MUST treat this as "abandon this task" — retrying just repeats the same
 * non-convergent run. Carries the cost/tokens burned so the caller can still
 * account for the (abandoned) work.
 */
export class AgentTimeoutError extends Error {
  readonly cost: number;
  readonly tokens?: TokenUsage;
  /**
   * Why the pass was abandoned: it investigated without converging ("time"), or its
   * model request went silent and did not recover after a fresh attempt ("stall").
   * The caller's handling is the same (abandon), but the two have different causes —
   * a wander is ours to bound, a stall is the provider's — so logs and coverage
   * notes must not conflate them.
   */
  readonly reason: "time" | "stall";
  constructor(
    agent: string,
    minutes: number,
    cost = 0,
    tokens?: TokenUsage,
    reason: "time" | "stall" = "time",
  ) {
    super(
      reason === "stall"
        ? `Agent "${agent}" stalled: its model request went silent and produced nothing after a retry (${minutes} minutes)`
        : `Agent "${agent}" timed out after ${minutes} minutes (including finalize)`,
    );
    this.name = "AgentTimeoutError";
    this.cost = cost;
    this.tokens = tokens;
    this.reason = reason;
  }
}

/**
 * Run a single prompt against the named agent in a fresh session and return the
 * concatenated assistant text.
 *
 * Uses the async prompt + polling rather than the synchronous `session.prompt`:
 * a large diff can keep an agent busy well past undici's 300s headers timeout,
 * which would kill a long-held synchronous request. promptAsync returns
 * immediately and we poll the message list (quick GETs) until the assistant
 * message completes.
 */
export async function promptAgent(
  handle: OpencodeHandle,
  args: {
    agent: string;
    system: string;
    text: string;
    title: string;
    /** Called once per tool the agent runs, for live progress (e.g. "read foo.ts"). */
    onActivity?: (line: string) => void;
    /** Per-attempt time ceiling. Defaults to DEFAULT_MAX_WAIT_MS. */
    maxWaitMs?: number;
    /**
     * Soft ceiling on the number of distinct tool calls the investigation may make.
     * Exceeding it trips the same soft-landing as the wall-clock cap (interrupt +
     * ask for findings so far). This bounds an agent that WANDERS — reads/greps
     * without converging — which is the root cause of the non-convergent 15-minute
     * timeouts. Undefined = no tool-call cap.
     */
    maxToolCalls?: number;
    /**
     * On hitting the ceiling, interrupt the run and ask the agent to return the
     * findings it has so far (a soft landing) instead of throwing immediately.
     */
    finalizeOnTimeout?: boolean;
  },
): Promise<PromptResult> {
  // A Claude handle never runs OpenCode's session/polling machinery: consumers
  // use promptAndParse, but guard here too so a direct call can't run this code
  // against a Claude handle. Dispatch is per-agent (see resolveEngineDispatch).
  const dispatch = resolveEngineDispatch(handle, args.agent);
  if (dispatch.engine === CLAUDE_CODE_ENGINE) {
    const { runClaudePrompt } = await import("./claude-code.js");
    return runClaudePrompt(dispatch.claudeHandle, args);
  }
  const maxWaitMs = args.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  // ONE deadline for the whole pass, shared by the first attempt and any stall
  // retry, so retrying a wedged request can never push the pass past its declared
  // cap (the budget math in review.ts depends on that being true).
  const deadline = Date.now() + maxWaitMs;
  // Spend from abandoned attempts, carried forward so a wedged attempt's cost and
  // tokens still land in the run's metrics instead of vanishing.
  let carriedCost = 0;
  let carriedTokens: TokenUsage | undefined;
  const carry = (result: PromptResult): PromptResult => ({
    ...result,
    cost: result.cost + carriedCost,
    tokens: addTokenUsage(addTokenUsage({}, carriedTokens), result.tokens),
  });
  const absorb = (spent: { cost: number; tokens?: TokenUsage }): void => {
    carriedCost += spent.cost;
    carriedTokens = addTokenUsage(addTokenUsage({}, carriedTokens), spent.tokens);
  };

  /**
   * Last chance to get something out of a pass that hit its ceiling: interrupt the
   * run and ask the SAME (context-carrying) session for whatever it already has.
   * Tools are disabled for this request, so it cannot resume investigating — the
   * only thing it can do is emit.
   */
  const softLand = async (
    sessionID: string,
    reason: "time" | "stall",
    reportedTools: Set<string>,
  ): Promise<PromptResult> => {
    await abortQuietly(handle, sessionID);
    const minutes = Math.round(maxWaitMs / 60000);
    if (!args.finalizeOnTimeout) {
      throw new AgentTimeoutError(args.agent, minutes, carriedCost, carriedTokens, reason);
    }
    // Only messages after this point count as the answer.
    const baseline = (await fetchMessages(handle, sessionID)).length;
    args.onActivity?.(
      reason === "stall"
        ? "no output after a retry — asking for findings so far"
        : "time budget reached — asking for findings so far",
    );
    await sendSessionPrompt(handle, sessionID, {
      agent: args.agent,
      system: args.system,
      text: FINALIZE_PROMPT,
      tools: NO_TOOLS,
    });
    try {
      const result = await pollForCompletion(handle, sessionID, {
        agent: args.agent,
        fromIndex: baseline,
        deadline: Date.now() + FINALIZE_WAIT_MS,
        onActivity: args.onActivity,
        reportedTools,
        stallMs: FINALIZE_STALL_MS,
      });
      return { ...carry(result), truncated: true };
    } catch (finalizeError) {
      if (finalizeError instanceof DeadlineReached || finalizeError instanceof NoProgress) {
        await abortQuietly(handle, sessionID);
        absorb(finalizeError);
        throw new AgentTimeoutError(
          args.agent,
          Math.round((maxWaitMs + FINALIZE_WAIT_MS) / 60000),
          carriedCost,
          carriedTokens,
          reason,
        );
      }
      throw finalizeError;
    }
  };

  let wedgedRetries = 0;
  for (let attempt = 0; ; attempt++) {
    const session = unwrap<{ id: string }>(
      await handle.client.session.create({
        body: { title: attempt === 0 ? args.title : `${args.title}-retry${attempt}` },
      }),
    );
    const reportedTools = new Set<string>();
    await sendSessionPrompt(handle, session.id, {
      agent: args.agent,
      system: args.system,
      text: args.text,
    });

    try {
      return carry(
        await pollForCompletion(handle, session.id, {
          agent: args.agent,
          fromIndex: 0,
          deadline,
          onActivity: args.onActivity,
          reportedTools,
          maxToolCalls: args.maxToolCalls,
          stallMs: stallWindowMs(maxWaitMs),
        }),
      );
    } catch (error) {
      // Went silent. The request is wedged, not slow, so the first move is a clean
      // slate — a fresh session, not the finalize prompt, which would be asking the
      // wedged request to answer. Exactly one retry, and only when enough budget
      // remains for it to land; after that the finalize is still worth a try as the
      // only remaining salvage (in eas-cli#4084 the session did respond once aborted).
      //
      // EXCEPT when the server log shows the account is rate-limited: then the
      // silence is throttling, not a wedge, and the patient move is to wait —
      // re-sending the pass's whole context would deepen the limit. Waits repeat
      // (never consuming the one wedged retry) until the evidence goes stale or
      // the pass runs out of room, both bounded by the pass deadline.
      if (error instanceof NoProgress) {
        await abortQuietly(handle, session.id);
        absorb(error);
        await handle.rateLimit.check();
        const remaining = deadline - Date.now();
        const action = stallAction(wedgedRetries, remaining, handle.rateLimit.recentlyLimited());
        if (action === "wait") {
          args.onActivity?.(
            `provider is rate-limiting this account (429 in the server log; ` +
              `${handle.rateLimit.events} so far) — waiting ${Math.round(RATE_LIMIT_WAIT_MS / 1000)}s ` +
              `instead of retrying (${Math.round(remaining / 60000)}m of budget left)`,
          );
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        if (action === "retry") {
          wedgedRetries++;
          args.onActivity?.(
            `stalled — no output for ${Math.round(error.idleMs / 1000)}s; ` +
              `retrying once from a clean session (${Math.round(remaining / 60000)}m of budget left)`,
          );
          await sleep(STALL_RETRY_BACKOFF_MS);
          continue;
        }
        return await softLand(session.id, "stall", reportedTools);
      }
      // Ran the clock down while investigating: converge on what it has.
      if (error instanceof DeadlineReached) {
        absorb(error);
        return await softLand(session.id, "time", reportedTools);
      }
      throw error;
    }
  }
}

export const CORRECTIVE =
  "\n\nIMPORTANT: your previous reply could not be parsed. Reply with ONLY the single " +
  "JSON object described above — no prose, no code fences, no partial output.";

// Budget for a corrective "re-emit the JSON" reply — no fresh investigation, so
// it should return almost immediately.
const CORRECTIVE_WAIT_MS = 2 * 60 * 1000;

/** Backoff (ms) before the 2nd and 3rd attempt of a transient-failing model call. */
const TRANSIENT_BACKOFF_MS = [2_000, 8_000];
/**
 * Rate limits need patience, not persistence: a limited account stays limited for
 * tens of seconds to minutes, so the 2s/8s schedule just burns the retries. Shared
 * subscription credentials (several PRs reviewing at once) make this the common
 * transient, hence the dedicated, slower schedule.
 */
const RATE_LIMIT_BACKOFF_MS = [15_000, 45_000, 90_000];

const RATE_LIMIT_ERROR = /\b429\b|rate.?limit|too many requests/i;

/** A transient error that is specifically a provider rate limit. */
export function isRateLimitError(error: unknown): boolean {
  return !(error instanceof AgentTimeoutError) && RATE_LIMIT_ERROR.test(errorMessage(error));
}

/**
 * A transient, retryable API failure — a one-off rate-limit (429), server error
 * (5xx), or network blip — as opposed to a timeout (which means "abandon", see
 * AgentTimeoutError) or a JSON-parse failure (handled by the corrective re-emit in
 * promptAndParse). We match on the error text because the OpenCode SDK surfaces
 * these as plain Errors; an AgentTimeoutError is never transient.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\b50[0-9]\b/,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang ?up/i,
  /network error/i,
  /fetch failed/i,
];

export function isTransientApiError(error: unknown): boolean {
  if (error instanceof AgentTimeoutError) {
    return false;
  }
  const message = errorMessage(error);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Run a model call, retrying with bounded backoff on a transient API error. This
 * is deliberately separate from the timeout path (abandon, never retry) and the
 * parse-failure path (corrective re-emit): a one-off 429/5xx/network error used to
 * drop the whole pass with no retry, reported as a coverage gap. Non-transient
 * errors (incl. AgentTimeoutError) propagate immediately.
 */
export async function withTransientRetry<T>(
  label: string,
  onActivity: ((line: string) => void) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Rate limits get the slower, longer schedule — see RATE_LIMIT_BACKOFF_MS.
      const schedule = isRateLimitError(error) ? RATE_LIMIT_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
      const waitMs = schedule[attempt];
      if (waitMs === undefined || !isTransientApiError(error)) {
        throw error;
      }
      onActivity?.(
        `${label}: transient API error (${errorMessage(error)}); retry ${attempt + 1}/${
          schedule.length
        } in ${Math.round(waitMs / 1000)}s`,
      );
      await sleep(waitMs);
    }
  }
}

/**
 * Prompt an agent and parse its reply. Claude-routed production parsers hand their
 * JSON Schema to the CLI, which repairs validation failures in-session before
 * returning. OpenCode retries a JSON-parse failure in the SAME session: the model
 * still holds all the file context it read, so the corrective is a cheap cache-read
 * re-emit with better recall than re-investigating. Only if that also fails does it
 * use a fresh session. A timeout is NOT a parse failure: AgentTimeoutError propagates
 * so the caller abandons the non-convergent task.
 */
export async function promptAndParse<T>(
  handle: OpencodeHandle,
  args: {
    agent: string;
    system: string;
    text: string;
    title: string;
    onActivity?: (line: string) => void;
    maxWaitMs?: number;
    maxToolCalls?: number;
    finalizeOnTimeout?: boolean;
  },
  parse: ((text: string) => T) & { jsonSchema?: Record<string, unknown> },
): Promise<{ value: T; cost: number; truncated: boolean; tokens: TokenUsage; model?: string }> {
  const dispatch = resolveEngineDispatch(handle, args.agent);
  if (dispatch.engine === CLAUDE_CODE_ENGINE) {
    const { claudeCodePromptAndParse } = await import("./claude-code.js");
    return claudeCodePromptAndParse(
      dispatch.claudeHandle,
      { ...args, jsonSchema: parse.jsonSchema },
      parse,
    );
  }
  let cost = 0;
  let truncated = false;
  let model: string | undefined;
  const tokens: TokenUsage = {};
  const record = (result: PromptResult): void => {
    cost += result.cost;
    truncated = truncated || (result.truncated ?? false);
    addTokenUsage(tokens, result.tokens);
    // Keep the model from whichever attempt actually answered.
    model = result.model ?? model;
  };

  const first = await withTransientRetry(`Agent "${args.agent}"`, args.onActivity, () =>
    promptAgent(handle, args),
  );
  record(first);
  try {
    return { value: parse(first.text), cost, truncated, tokens, model };
  } catch {
    // Same-session corrective retry: send the nudge as a follow-up and wait for
    // the NEW assistant message (past the current message count).
    try {
      const baseline = (await fetchMessages(handle, first.sessionID)).length;
      await sendSessionPrompt(handle, first.sessionID, {
        agent: args.agent,
        system: args.system,
        text: CORRECTIVE,
        // Re-emit only: the investigation is done, so no tools are needed and
        // disabling them keeps the corrective from turning into a second wander.
        tools: NO_TOOLS,
      });
      const retry = await pollForCompletion(handle, first.sessionID, {
        agent: args.agent,
        fromIndex: baseline,
        deadline: Date.now() + CORRECTIVE_WAIT_MS,
        onActivity: args.onActivity,
        reportedTools: new Set<string>(),
        stallMs: FINALIZE_STALL_MS,
      });
      record(retry);
      return { value: parse(retry.text), cost, truncated, tokens, model };
    } catch {
      // Fresh-session last resort: a clean slate for a genuinely confused run.
      const fresh = await promptAgent(handle, {
        ...args,
        text: args.text + CORRECTIVE,
        finalizeOnTimeout: false,
      });
      record(fresh);
      try {
        return { value: parse(fresh.text), cost, truncated, tokens, model };
      } catch (finalError) {
        throw new Error(
          `Agent "${args.agent}" did not return parseable JSON after retries: ${
            finalError instanceof Error ? finalError.message : String(finalError)
          }`,
        );
      }
    }
  }
}

// ---- session helpers (shared by promptAgent + promptAndParse) ----

interface RawMessage {
  info?: {
    role?: string;
    error?: unknown;
    cost?: number;
    tokens?: TokenUsage;
    time?: { completed?: number };
    /** Which provider/model the server actually used for this reply. */
    providerID?: string;
    modelID?: string;
  };
  parts?: Array<{
    id?: string;
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: { status?: string; title?: string };
  }>;
}

async function fetchMessages(handle: OpencodeHandle, sessionID: string): Promise<RawMessage[]> {
  return unwrap<RawMessage[]>(await handle.client.session.messages({ path: { id: sessionID } }));
}

async function sendSessionPrompt(
  handle: OpencodeHandle,
  sessionID: string,
  args: {
    agent: string;
    system: string;
    text: string;
    /** Per-request tool override (see NO_TOOLS). Omit to use the agent's own set. */
    tools?: Record<string, boolean>;
  },
): Promise<void> {
  unwrap(
    await handle.client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent: args.agent,
        system: args.system,
        parts: [{ type: "text", text: args.text }],
        ...(args.tools ? { tools: args.tools } : {}),
      },
    }),
  );
}

async function abortQuietly(handle: OpencodeHandle, sessionID: string): Promise<void> {
  try {
    await handle.client.session.abort({ path: { id: sessionID } });
  } catch {
    // best effort — the session may already be gone
  }
}

/**
 * Poll a session for the first assistant message at or after `fromIndex` to
 * complete. `fromIndex` lets a follow-up prompt (finalize, corrective retry)
 * skip the earlier completed message and wait for the NEW reply instead. Throws
 * DeadlineReached once `deadline` passes, or NoProgress once the reply has been
 * unchanged for `stallMs` (see STALL_MS).
 */
async function pollForCompletion(
  handle: OpencodeHandle,
  sessionID: string,
  opts: {
    agent: string;
    fromIndex: number;
    deadline: number;
    onActivity?: (line: string) => void;
    reportedTools: Set<string>;
    maxToolCalls?: number;
    /** No-progress ceiling. Undefined = no stall watchdog (never wait forever on
     * a wedged request unless the caller has its own reason to). */
    stallMs?: number;
  },
): Promise<PromptResult> {
  // Best-effort usage of the in-progress assistant message, so a task that times
  // out before completing still contributes its spend to the run's metrics.
  let lastCost = 0;
  let lastTokens: TokenUsage | undefined;
  const startedAt = Date.now();
  let lastEmitAt = startedAt;
  // Stall watchdog state: when the reply last changed in any way, and what it looked
  // like then. Starts at "now" so a prompt that never produces an assistant message
  // at all (a wedged submission) also trips the watchdog.
  let lastProgressAt = startedAt;
  let lastFingerprint = "";
  const emit = (line: string): void => {
    lastEmitAt = Date.now();
    opts.onActivity?.(line);
  };
  for (;;) {
    if (Date.now() > opts.deadline) {
      throw new DeadlineReached(lastCost, lastTokens);
    }
    await sleep(POLL_INTERVAL_MS);

    // Heartbeat if nothing has been reported for a while (e.g. the model is
    // reasoning without calling tools), so a long pass doesn't look hung. Say how
    // long the reply has been unchanged, not just how long the pass has run — that
    // distinction is what tells a slow investigation apart from a wedged request,
    // and its absence is why eas-cli#4084 took a forensic dig to explain.
    if (opts.onActivity && Date.now() - lastEmitAt >= HEARTBEAT_MS) {
      const idleMs = Date.now() - lastProgressAt;
      emit(
        `still working… ${Math.round((Date.now() - startedAt) / 1000)}s elapsed` +
          (idleMs >= HEARTBEAT_MS ? ` (no new output for ${Math.round(idleMs / 1000)}s)` : ""),
      );
    }

    // Bound the fetch by the deadline: a stalled server can't push the task past
    // its time cap (the overshoot we saw when the server was overloaded).
    const messages = await raceDeadline(fetchMessages(handle, sessionID), opts.deadline);
    if (messages === DEADLINE_SENTINEL) {
      throw new DeadlineReached(lastCost, lastTokens);
    }
    const recent = messages.slice(opts.fromIndex);
    const assistant = [...recent].reverse().find((message) => message.info?.role === "assistant");
    if (!assistant) {
      continue;
    }
    if (typeof assistant.info?.cost === "number") {
      lastCost = assistant.info.cost;
    }
    if (assistant.info?.tokens) {
      lastTokens = assistant.info.tokens;
    }

    // Stall watchdog: did the reply change AT ALL since the last poll?
    const fingerprint = progressFingerprint(assistant);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastProgressAt = Date.now();
    }

    // Track each distinct tool call once (for the tool-call cap) and, the first
    // time it starts, emit a live line so a long run shows what the agent is doing.
    for (const part of assistant.parts ?? []) {
      if (part?.type !== "tool") {
        continue;
      }
      const key = part.callID ?? part.id;
      const status = part.state?.status;
      if (key && status && status !== "pending" && !opts.reportedTools.has(key)) {
        opts.reportedTools.add(key);
        if (opts.onActivity) {
          const tool = part.tool ?? "tool";
          const title = part.state?.title;
          emit(title ? `${tool}: ${title}` : tool);
        }
      }
    }
    if (assistant.info?.error) {
      throw new Error(
        `Agent "${opts.agent}" returned an error: ${JSON.stringify(assistant.info.error)}`,
      );
    }

    // A completed message ALWAYS wins — return it regardless of tool count; the
    // work is done, so there's nothing to finalize.
    if (assistant.info?.time?.completed != null) {
      const text = (assistant.parts ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      return {
        text,
        cost: assistant.info?.cost ?? 0,
        sessionID,
        tokens: assistant.info?.tokens,
        model: formatModel(assistant.info?.providerID, assistant.info?.modelID),
      };
    }

    // Still in progress: enforce the tool-call cap. An agent that has made this
    // many tool calls without finishing is wandering, not converging — trip the
    // same soft-landing as the wall-clock deadline so it returns what it has.
    if (opts.maxToolCalls != null && opts.reportedTools.size > opts.maxToolCalls) {
      emit(`made ${opts.reportedTools.size} tool calls — wrapping up to stay on budget`);
      throw new DeadlineReached(lastCost, lastTokens);
    }

    // Still in progress and completely silent: the request is wedged, not slow.
    // Bail out NOW rather than spending the rest of the cap on a dead request —
    // the caller retries a stall from a clean session (see promptAgent).
    if (opts.stallMs != null) {
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs >= opts.stallMs) {
        emit(
          `no new output for ${Math.round(idleMs / 1000)}s — treating the model request as stalled`,
        );
        throw new NoProgress(lastCost, lastTokens, idleMs);
      }
    }
  }
}
