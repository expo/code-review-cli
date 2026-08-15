// @ref LLP 0003#claude-code-cli-containment [implements] — argv/env hardening for the claude -p subprocess
// @ref LLP 0003#two-engines-per-agent-dispatch [implements] — anthropic/* routing and the per-agent engine map
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoadedConfig } from "../config/schema.js";
import { checkAuthEntry } from "./auth.js";
import { pathInside, resolveOnPath, run } from "./exec.js";
import {
  addTokenUsage,
  AgentTimeoutError,
  CLAUDE_CODE_ENGINE,
  CROSS_CUTTING_AGENT,
  STACK_VERIFIER_AGENT,
  VERIFIER_AGENT,
  withTransientRetry,
} from "./opencode.js";
import type { OpencodeHandle, PromptResult, TokenUsage } from "./opencode.js";
import { RateLimitWatch } from "./throttle.js";
import { CLAUDE_RESEARCH_TOOLS } from "./research.js";
import type { ResearchMcpRuntime } from "./research.js";

/**
 * The Claude Code CLI review engine. Runs each pass as a single `claude -p
 * --output-format stream-json --verbose` subprocess on the user's Claude Max/Team subscription,
 * bypassing OpenCode entirely (which cannot use Anthropic subscription OAuth).
 * The seam functions in opencode.ts dispatch here on `handle.engine`.
 *
 * Per-agent `temperature` is NOT supported: the `claude` CLI exposes no
 * temperature flag, so any configured temperature is dropped (surfaced once per run
 * via claudeTemperatureNote so the divergence is visible).
 */
export interface ClaudeCodeHandle extends OpencodeHandle {
  engine: "claude-code";
  /** agent id → configured model id (mirrors buildOpencodeConfig's model map). */
  models: Record<string, string>;
  /**
   * agent id → the OpenCode tool names that role may use (mirrors buildOpencodeConfig's
   * per-agent tool maps): reviewers get their configured tools, cross-cutting/verifier
   * get read+grep (Glob withheld), the coordinator gets none. buildClaudeArgs scopes
   * the read-capable subset to the tree.
   */
  tools: Record<string, readonly string[]>;
  /** Default model for cross-cutting/verifier (config.agents[0].model). */
  defaultModel: string;
  /** Absolute `claude` binary (PATH lookup). */
  cliPath: string;
  /** Child-process env built from an allowlist that omits ANTHROPIC_API_KEY/AUTH_TOKEN;
   *  the resolved Claude credential is re-injected here — CLAUDE_CODE_OAUTH_TOKEN for a
   *  subscription token, ANTHROPIC_API_KEY for a Console key (the CLI reads either). */
  childEnv: NodeJS.ProcessEnv;
  /** Owner-only config for the single built-in documentation MCP. */
  researchMcpConfigPath?: string;
  /** Only reviewer and cross-cutting roles may receive the documentation tools. */
  researchAgents?: ReadonlySet<string>;
}

/** Prompt args, structurally shared with promptAgent/promptAndParse in opencode.ts. */
export interface ClaudePromptArgs {
  agent: string;
  system: string;
  text: string;
  title: string;
  onActivity?: (line: string) => void;
  maxWaitMs?: number;
  maxToolCalls?: number;
  finalizeOnTimeout?: boolean;
  /** Provider-enforced output contract, generated from the local Zod parser. */
  jsonSchema?: Record<string, unknown>;
}

/** Coarse per-pass wander bound; the review's own maxWaitMs is the real ceiling. */
const CLAUDE_MAX_TURNS = 60;
/** Fallback per-pass ceiling when a caller passes no maxWaitMs. */
const DEFAULT_MAX_WAIT_MS = 8 * 60 * 1000;
/**
 * Emit a "still working" heartbeat after this long with no structured stream
 * activity (matching opencode.ts's HEARTBEAT_MS), so a thinking stretch still has
 * a progress signal between tool calls.
 */
const CLAUDE_HEARTBEAT_MS = 45_000;

/**
 * OpenCode read-tool name → Claude Code tool name. These three are the only tools
 * this engine ever grants; write/exec/net tools are always denied (review is
 * read-only). `list` has no scoped Claude equivalent (Glob covers discovery) and is
 * ignored.
 */
const READ_TOOL_MAP: Record<string, "Read" | "Grep" | "Glob"> = {
  read: "Read",
  grep: "Grep",
  glob: "Glob",
};
const ALL_READ_TOOLS = ["Read", "Grep", "Glob"] as const;
// @ref LLP 0003#claude-code-cli-containment [implements] — deny enumeration (not allow-only) because an empty/absent --allowedTools list default-ALLOWS reads; verified against claude 2.1.212, revisit on every CLI version bump
/**
 * Tools never available to a review pass, whatever the role. A DENY enumeration is
 * the only workable containment: permission rules cannot fail closed here — reads
 * inside the workspace are default-ALLOWED even when an allow list is present but
 * unmatched, and a `*` deny breaks tool calling outright (both verified against
 * claude 2.1.212). The residual risk — a FUTURE CLI version shipping a new
 * read-capable tool this list doesn't name — is bounded by pinning the CLI version
 * (the scaffolded workflow installs an exact @anthropic-ai/claude-code version;
 * bump it deliberately and revisit this list). Unknown names are ignored by the
 * CLI, so denying tools that don't exist in a given version is harmless.
 */
const ALWAYS_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "BashOutput",
  "KillShell",
  "ExitPlanMode",
];

/**
 * Env vars forwarded to the `claude` child — what a CLI needs to run (PATH,
 * locale, tmp, proxies, its own config dir) and nothing else. See startClaudeCode
 * for why this is an allowlist.
 */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "CLAUDE_CONFIG_DIR",
  // Windows equivalents of the above.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "COMSPEC",
  "PATHEXT",
];

const MISSING_CLI_MESSAGE =
  "The `claude` CLI is not installed. Install Claude Code (npm i -g " +
  "@anthropic-ai/claude-code) and run `claude setup-token` on a Max/Team " +
  "subscription, then `ecr doctor`.";

export type Engine = "opencode" | "claude-code";

/**
 * Infer ONE agent's engine from its resolved model alone: an `anthropic/…` model
 * runs through the Claude Code CLI, any other provider through OpenCode. The engine
 * is a pure function of the model id — no auth, no run-level state — so a single run
 * may drive BOTH engines at once (per agent, by model). ALL anthropic models are
 * served by the CLI; the retired anthropic-via-OpenCode x-api-key path no longer
 * exists (the CLI accepts an API key too).
 */
// @ref LLP 0003#two-engines-per-agent-dispatch [implements] — engine choice is a pure function of the model id's provider prefix, no run-level auth-mode switch
export function engineForModel(model: string): Engine {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : model;
  return provider === "anthropic" ? CLAUDE_CODE_ENGINE : "opencode";
}

/**
 * Map every dispatchable agent id → its engine + model: each reviewer id, plus the
 * fixed cross-cutting / verifier / coordinator roles. This modelOf is the single
 * source for which model backs each id — startClaudeCode (below) consumes it directly
 * instead of rebuilding it, and buildOpencodeConfig (opencode.ts) folds the same ids
 * into its richer per-role agent records. The per-model inference converges to one
 * engine automatically when every model is identical (e.g. under REVIEWER_MODEL), so
 * no run-level convergence code is needed.
 *
 * `agents` scopes the reviewer ids to a specific run's SELECTED agents (an explicit
 * `--agents` subset); it defaults to the full roster. usesOpencode/usesClaude then
 * report only the engines that run actually drives, so a subset whose passes never
 * touch Claude doesn't force startClaudeCode (missing CLI/token) for nothing. The
 * fixed roles always run, so the verifier/cross-cutting shared model and the
 * coordinator model stay on the FULL roster (config.agents[0] / coordinator) — those
 * passes use them regardless of which reviewers were selected.
 */
export function buildEngineMap(
  config: LoadedConfig,
  agents: readonly LoadedConfig["agents"][number][] = config.agents,
): {
  engineOf: Record<string, Engine>;
  modelOf: Record<string, string>;
  usesOpencode: boolean;
  usesClaude: boolean;
} {
  const modelOf: Record<string, string> = {};
  for (const agent of agents) {
    modelOf[agent.id] = agent.model;
  }
  const shared = config.agents[0]?.model ?? config.coordinator.model;
  modelOf[CROSS_CUTTING_AGENT] = shared;
  modelOf[VERIFIER_AGENT] = shared;
  // @ref LLP 0010#patch-level-confirmation-v2 [constrained-by] — the id MUST live in modelOf/engineOf or a claude-routed run dispatches against an undefined handle and crashes
  modelOf[STACK_VERIFIER_AGENT] = shared;
  modelOf["coordinator"] = config.coordinator.model;
  const engineOf: Record<string, Engine> = {};
  for (const [id, model] of Object.entries(modelOf)) {
    engineOf[id] = engineForModel(model);
  }
  const engines = new Set(Object.values(engineOf));
  return {
    engineOf,
    modelOf,
    usesOpencode: engines.has("opencode"),
    usesClaude: engines.has(CLAUDE_CODE_ENGINE),
  };
}

/** Strip a leading `provider/` segment for the CLI's `--model` flag. */
export function claudeModelId(configModel: string): string {
  const slash = configModel.indexOf("/");
  return slash >= 0 ? configModel.slice(slash + 1) : configModel;
}

/**
 * Whether a configured model id and the model that actually answered are the same
 * family, ignoring a trailing dated suffix (`claude-haiku-4-5-20251001` matches
 * `claude-haiku-4-5` / `anthropic/claude-haiku-4-5`). A plain fallback within the
 * family reports the CONFIGURED id (no spurious substitution note); a real swap to
 * a different family reports the actual id so the substitution surfaces.
 */
export function claudeModelMatches(requested: string, actualKey: string): boolean {
  const normalize = (id: string): string => claudeModelId(id).replace(/-\d{8}$/, "");
  return normalize(requested) === normalize(actualKey);
}

/**
 * The read-only, trust-isolated, subscription-forced argv (minus the leading
 * binary). Task text is fed on stdin, not here. NOT `--bare` (bare mode ignores
 * CLAUDE_CODE_OAUTH_TOKEN/keychain OAuth); `--safe-mode` disables
 * CLAUDE.md/hooks/MCP/plugins while KEEPING OAuth.
 *
 * The granted read tools vary by role (see the `tools` option): a reviewer gets its
 * configured read/grep/glob, the cross-file and verifier passes get read+grep only
 * (Glob withheld — directory crawling is what made them wander), and the coordinator
 * plus the no-tools fallback get none. Whatever the role, every GRANTED read tool is
 * path-scoped to the review tree (`//<cwd>/**`, Claude Code's absolute-path rule)
 * with `dontAsk` denying any call that matches no allow rule. This narrows the
 * prompt-injection exfil path for DIRECT out-of-tree reads: untrusted PR content is
 * the review input and findings are posted as PR comments, so any unscoped
 * read-capable tool (a bare `Grep` no less than a bare `Read`) would let an injected
 * instruction read `~/.claude/.credentials.json` (the subscription token this engine
 * authenticates with), `/proc/self/environ`, `.env*`, or SSH keys and emit them into
 * a finding. Verified empirically against the installed CLI: in-tree Read/Grep
 * succeed, out-of-tree Read/Grep/Glob (`/etc`, `~/.zshrc`) are denied by the
 * unmatched-rule denial; a withheld read tool is denied BY NAME because an EMPTY
 * allow list default-allows reads. NO scoped deny rules: `Read(//**)` would deny the
 * tree itself (paths resolve to absolute), and `Read(~/**)` denies the whole tree
 * whenever the repo lives under the home directory — the common case.
 *
 * This is NOT, by itself, a boundary against a symlink committed inside the PR-head
 * tree (e.g. `docs/notes.md -> ~/.claude/.credentials.json`): the permission rule
 * matches the literal path ARGUMENT, which is in-tree, but Read/Grep then follow the
 * symlink via fs and return the out-of-tree target's contents. That gap is closed
 * UPSTREAM of this argv, where there is still a filesystem to preflight: read-root
 * materialization strips symlinks that resolve outside the tree
 * (removeEscapingSymlinks in scrub.ts, run by prepareReadRootAsync). Runs whose read
 * root is the user's own checkout (local diffs) don't get the sweep — the user is
 * the trust principal for their own tree's symlinks.
 */
export function buildClaudeArgs(opts: {
  model: string;
  system: string;
  cwd: string;
  /**
   * OpenCode tool names this pass may use (read/grep/glob honored and scoped to the
   * tree; write/exec/net and unknown names ignored). Undefined = the three read
   * tools (back-compat default). An EMPTY array denies every read tool: an absent
   * `--allowedTools` list default-ALLOWS reads (verified against claude 2.1.212), so
   * the coordinator and the no-tools fallback must deny Read/Grep/Glob by NAME, not
   * by omission.
   */
  tools?: readonly string[];
  researchMcpConfigPath?: string;
  maxTurns?: number;
  jsonSchema?: Record<string, unknown>;
}): string[] {
  // Permission rules are gitignore-style with forward slashes; a Windows cwd
  // (`C:\Users\dev\repo`) must be normalized or every rule silently matches
  // nothing and dontAsk denies all reads.
  const scopeRoot = opts.cwd.replace(/\\/g, "/");
  const scope = (tool: string): string => `${tool}(/${scopeRoot}/**)`;
  const requested = opts.tools ?? ["read", "grep", "glob"];
  const enabled = ALL_READ_TOOLS.filter((claudeName) =>
    requested.some((name) => READ_TOOL_MAP[name] === claudeName),
  );
  // Read tools NOT granted are denied by name (see the `tools` doc above) — the
  // scoped allow rules alone don't deny them when the allow list is empty.
  const deniedReadTools = ALL_READ_TOOLS.filter((tool) => !enabled.includes(tool));
  const researchTools = opts.researchMcpConfigPath ? [...CLAUDE_RESEARCH_TOOLS] : [];
  const allowedTools = [...enabled.map(scope), ...researchTools];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--append-system-prompt",
    opts.system,
    ...(opts.jsonSchema ? ["--json-schema", JSON.stringify(opts.jsonSchema)] : []),
    ...(allowedTools.length > 0 ? ["--allowedTools", ...allowedTools] : []),
    "--disallowedTools",
    ...deniedReadTools,
    ...ALWAYS_DENIED_TOOLS,
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    ...(opts.researchMcpConfigPath
      ? [
          "--mcp-config",
          opts.researchMcpConfigPath,
          "--setting-sources",
          "",
          "--disable-slash-commands",
        ]
      : ["--safe-mode"]),
    "--no-session-persistence",
    "--max-turns",
    String(opts.maxTurns ?? CLAUDE_MAX_TURNS),
  ];
}

export interface ClaudeResult {
  text: string;
  cost: number;
  tokens: TokenUsage;
  /** modelUsage key → output tokens, for picking the model that actually answered. */
  modelOutputTokens: Record<string, number>;
  isError: boolean;
  errorText: string;
  /** Whether the final result carried the object validated by `--json-schema`. */
  hasStructuredOutput: boolean;
  /** Claude Code exhausted its own in-session structured-output repair attempts. */
  structuredOutputFailure: boolean;
}

const CLAUDE_STREAM_MISSING_RESULT = "Claude Code stream ended without a final result event";
const CLAUDE_RESULT_MISSING_ERROR = "Claude Code returned an error without a message";

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** The final result object from either legacy single JSON or JSONL stream output. */
function finalClaudeResult(stdout: string): JsonRecord | null {
  try {
    const parsed = jsonRecord(JSON.parse(stdout));
    return parsed?.type === "result" ? parsed : null;
  } catch {
    let result: JsonRecord | null = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = jsonRecord(JSON.parse(line));
        if (event?.type === "result") {
          result = event;
        }
      } catch {
        // A malformed/non-JSON line cannot be the structured final result.
      }
    }
    return result;
  }
}

const MAX_ACTIVITY_DETAIL = 180;

/** Collapse control/newline injection and bound provider/model-originated log text. */
function safeActivityDetail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const withoutControls = [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : char;
    })
    .join("");
  const clean = withoutControls.replace(/\s+/g, " ").trim();
  if (!clean) {
    return undefined;
  }
  return clean.length > MAX_ACTIVITY_DETAIL ? `${clean.slice(0, MAX_ACTIVITY_DETAIL - 1)}…` : clean;
}

/** Render an in-tree tool target without exposing attempted host paths. */
function activityPath(value: unknown, cwd: string): string | undefined {
  const candidate = safeActivityDetail(value);
  if (!candidate) {
    return undefined;
  }
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  if (absolute !== root && !pathInside(absolute, root)) {
    return undefined;
  }
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  return relative || ".";
}

interface ClaudeActivity {
  /** Stable tool-use id; repeated assistant events with the same id log once. */
  key?: string;
  line: string;
}

/**
 * Convert one Claude stream event into safe progress metadata. Raw assistant text,
 * tool results, and grep patterns are deliberately never logged: PR/model content is
 * untrusted and may contain secrets or terminal-control/log-injection payloads.
 */
// @ref LLP 0003#claude-code-cli-containment [implements] — stream only bounded lifecycle/tool metadata; raw model text and tool results never become progress logs
export function claudeActivities(eventValue: unknown, cwd: string): ClaudeActivity[] {
  const event = jsonRecord(eventValue);
  if (!event) {
    return [];
  }
  if (event.type === "system" && event.subtype === "init") {
    const model = safeActivityDetail(event.model);
    return [{ line: model ? `started ${model}` : "started" }];
  }
  if (event.type === "result") {
    if (event.is_error === true) {
      return [];
    }
    const duration =
      typeof event.duration_ms === "number"
        ? `${Math.max(0, Math.round(event.duration_ms / 1000))}s`
        : null;
    const turns = typeof event.num_turns === "number" ? `${event.num_turns} turn(s)` : null;
    const detail = [duration, turns].filter(Boolean).join(", ");
    return [{ line: detail ? `completed (${detail})` : "completed" }];
  }
  if (event.type !== "assistant") {
    return [];
  }
  const message = jsonRecord(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const activities: ClaudeActivity[] = [];
  for (const value of content) {
    const block = jsonRecord(value);
    if (block?.type !== "tool_use" || typeof block.name !== "string") {
      continue;
    }
    const input = jsonRecord(block.input) ?? {};
    const key = typeof block.id === "string" ? block.id : undefined;
    if (block.name === "Read") {
      const target = activityPath(input.file_path, cwd);
      activities.push({ key, line: target ? `Read ${target}` : "Read" });
    } else if (block.name === "Grep") {
      const target = activityPath(input.path, cwd);
      activities.push({ key, line: target ? `Grep ${target}` : "Grep" });
    } else if (block.name === "Glob") {
      const target = activityPath(input.path, cwd);
      activities.push({ key, line: target && target !== "." ? `Glob ${target}` : "Glob" });
    }
  }
  return activities;
}

/** Incremental JSONL decoder for Claude's stream-json stdout. */
export function createClaudeActivityStream(
  cwd: string,
  onActivity: (line: string) => void,
): { push: (chunk: string) => void; finish: () => void } {
  let buffered = "";
  const reported = new Set<string>();
  const consume = (line: string): void => {
    if (!line.trim()) {
      return;
    }
    try {
      for (const activity of claudeActivities(JSON.parse(line), cwd)) {
        if (activity.key && reported.has(activity.key)) {
          continue;
        }
        if (activity.key) {
          reported.add(activity.key);
        }
        onActivity(activity.line);
      }
    } catch {
      // Ignore malformed progress events; final result parsing still reports errors.
    }
  };
  return {
    push(chunk: string): void {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) {
          break;
        }
        consume(buffered.slice(0, newline).replace(/\r$/, ""));
        buffered = buffered.slice(newline + 1);
      }
    },
    finish(): void {
      consume(buffered);
      buffered = "";
    },
  };
}

/**
 * The model that actually answered, out of the result's modelUsage keys. The CLI
 * also bills its own internal helper calls there (a haiku entry appears alongside
 * the main model, often FIRST — key order is meaningless), so prefer the key
 * matching the requested family and fall back to the largest output-token count
 * (the main model dominates output; helpers emit a trickle).
 */
export function pickAnsweringModel(
  requested: string,
  modelOutputTokens: Record<string, number>,
): string | undefined {
  const keys = Object.keys(modelOutputTokens);
  const familyMatch = keys.find((key) => claudeModelMatches(requested, key));
  if (familyMatch) {
    return familyMatch;
  }
  return keys.sort((a, b) => (modelOutputTokens[b] ?? 0) - (modelOutputTokens[a] ?? 0))[0];
}

/**
 * Parse the final result from `--output-format stream-json` JSONL (also accepts the
 * former single JSON object for compatibility/tests). Keys off `is_error` / a parse
 * failure, NOT `subtype` — `subtype` stays `"success"` on some API errors.
 */
export function parseClaudeResult(stdout: string): ClaudeResult {
  const parsed = finalClaudeResult(stdout);
  if (!parsed) {
    // The stream may contain assistant text and tool results sourced from the
    // untrusted review tree. Never turn that transcript into an error message or
    // feed it to provider-error classification.
    // @ref LLP 0003#claude-code-cli-containment [constrained-by] — raw JSONL transcript content must never reach logs or error classifiers
    return {
      text: "",
      cost: 0,
      tokens: {},
      modelOutputTokens: {},
      isError: true,
      errorText: CLAUDE_STREAM_MISSING_RESULT,
      hasStructuredOutput: false,
      structuredOutputFailure: false,
    };
  }
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;
  const tokens: TokenUsage = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    reasoning: num(
      (usage.output_tokens_details as Record<string, unknown> | null | undefined)?.thinking_tokens,
    ),
    cache: {
      write: num(usage.cache_creation_input_tokens),
      read: num(usage.cache_read_input_tokens),
    },
  };
  const modelUsage = (parsed.modelUsage ?? {}) as Record<string, unknown>;
  const modelOutputTokens: Record<string, number> = {};
  for (const [key, value] of Object.entries(modelUsage)) {
    modelOutputTokens[key] = num((value as Record<string, unknown> | null)?.outputTokens) ?? 0;
  }
  const isError = parsed.is_error === true;
  const hasStructuredOutput = parsed.structured_output !== undefined;
  // `--json-schema` returns a provider-validated object in `structured_output`.
  // Serialize it back through the existing local parser so Zod remains the final
  // trust boundary. Ignore any stale/retracted structured value on an error result;
  // error classification must use only the CLI's explicit final error message.
  const structured =
    isError || parsed.structured_output === undefined
      ? undefined
      : JSON.stringify(parsed.structured_output);
  const result = structured ?? (typeof parsed.result === "string" ? parsed.result : "");
  return {
    text: result,
    cost: num(parsed.total_cost_usd) ?? 0,
    tokens,
    modelOutputTokens,
    isError,
    // Only the final result event's explicit error text is safe to classify and
    // surface. Falling back to stdout would expose the full JSONL transcript.
    errorText: isError ? result || CLAUDE_RESULT_MISSING_ERROR : "",
    hasStructuredOutput,
    structuredOutputFailure: parsed.subtype === "error_max_structured_output_retries",
  };
}

/**
 * A provider-side schema failure that spent tokens and may be retried once from a
 * clean process. Carrying the attempt lets the caller retain honest run metrics.
 */
class ClaudeStructuredOutputError extends Error {
  constructor(readonly result: PromptResult) {
    super("Claude Code could not produce output matching the required JSON Schema");
    this.name = "ClaudeStructuredOutputError";
  }
}

/** Classify a Claude Code failure so the caller can pick backoff vs. hard fail. */
export function classifyClaudeError(
  errorText: string,
  apiStatus?: number,
): "rate-limit" | "auth" | "usage-limit" | "other" {
  if (apiStatus === 401 || apiStatus === 403) {
    return "auth";
  }
  if (apiStatus === 429) {
    return "rate-limit";
  }
  if (/authentication_failed|oauth_org_not_allowed|invalid.?api.?key|\b401\b/i.test(errorText)) {
    return "auth";
  }
  if (/usage limit reached/i.test(errorText)) {
    return "usage-limit";
  }
  if (/\b429\b|rate.?limit|too many requests|overloaded|quota/i.test(errorText)) {
    return "rate-limit";
  }
  return "other";
}

/**
 * The reset epoch (ms) a `usage limit reached|<epoch>` message carries, or null.
 * Parsed defensively — the trailing `|<epoch>` is folklore, in seconds or ms.
 */
export function usageLimitResetMs(errorText: string): number | null {
  const match = /\|\s*(\d{6,})/.exec(errorText);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  // A 10-digit value is epoch seconds; a 13-digit is already ms.
  return value < 1e12 ? value * 1000 : value;
}

/**
 * The thrown-error text for a usage-limit hit. Deliberately phrased so
 * isTransientApiError MISSES it — no "rate limit"/"429"/"too many requests"/
 * "overloaded" — because a subscription usage cap resets hours later, not in
 * seconds: without this it matched the 429 pattern and burned the whole
 * RATE_LIMIT_BACKOFF schedule on three doomed retries. Failing fast surfaces the
 * reset time instead. The interpolated reset epoch is a long digit run with no
 * internal word boundary, so it can't spuriously match `\b429\b`/`\b50x\b`.
 */
// @ref LLP 0003#retry-taxonomy [constrained-by] — message text deliberately avoids matching isTransientApiError's regex so a subscription cap fails fast rather than retrying
export function usageLimitMessage(errorText: string): string {
  const resetMs = usageLimitResetMs(errorText);
  const when = resetMs ? new Date(resetMs).toISOString() : "later";
  return (
    `Claude Code usage limit reached; resets ${when}. This is a subscription usage cap, ` +
    `not a transient throttle — retrying will not clear it. (${errorText})`
  );
}

/** Agent/coordinator default temperatures (mirrors load.ts resolveTemp fallbacks). */
const DEFAULT_AGENT_TEMPERATURE = 0.1;
const DEFAULT_COORDINATOR_TEMPERATURE = 0;

/**
 * A one-time run note when a config sets a NON-default temperature under the
 * claude-code engine: the `claude` CLI exposes no temperature flag, so every
 * configured temperature is silently dropped. Only non-default values are flagged (a
 * config left on the default never expected an effect), so a plain setup stays quiet.
 * Returns null when there is nothing to surface.
 */
export function claudeTemperatureNote(
  config: LoadedConfig,
  engineOf: Record<string, Engine>,
): string | null {
  // Only CLAUDE-ROUTED passes drop their temperature; in a mixed run an
  // OpenCode-routed agent's tuned temperature IS honored and must not be flagged.
  const tuned =
    config.agents.some(
      (agent) =>
        engineOf[agent.id] === CLAUDE_CODE_ENGINE &&
        agent.temperature !== DEFAULT_AGENT_TEMPERATURE,
    ) ||
    (engineOf["coordinator"] === CLAUDE_CODE_ENGINE &&
      config.coordinator.temperature !== DEFAULT_COORDINATOR_TEMPERATURE);
  return tuned
    ? "temperature settings are not supported by the claude-code engine and were ignored " +
        "(for the claude-routed passes)"
    : null;
}

/**
 * Preserve actionable process diagnostics without copying arbitrary stderr into a
 * public Actions log. A non-empty stream may already contain model/tool content, so
 * stderr is not even classified in that case. With no stream, recognize only fixed
 * CLI/setup categories and never interpolate the matched text.
 */
// @ref LLP 0003#claude-code-cli-containment [constrained-by] — stderr may reflect untrusted tree content; expose only exit metadata and fixed allowlisted categories
function claudeExitDiagnostic(result: { stdout: string; stderr: string; code: number }): string {
  const exit = `Claude Code exited with code ${result.code}`;
  if (result.stdout.trim() !== "") {
    return exit;
  }

  if (/unknown (?:option|argument)|unrecognized option|unexpected argument/i.test(result.stderr)) {
    return (
      `${exit}; the CLI rejected its arguments — verify the pinned ` +
      "@anthropic-ai/claude-code version supports the configured flags"
    );
  }
  if (/authentication|oauth|api.?key|unauthorized|\b401\b|\b403\b/i.test(result.stderr)) {
    return (
      `${exit}; authentication failed before a result was emitted — check ` +
      "`claude auth status` and `ecr doctor`"
    );
  }
  if (/\bENOENT\b|command not found|no such file or directory/i.test(result.stderr)) {
    return `${exit}; the Claude Code executable or one of its required files was not found`;
  }
  if (/\bEACCES\b/i.test(result.stderr)) {
    return `${exit}; the Claude Code executable could not be launched due to permissions`;
  }
  return exit;
}

/**
 * One prompt → text/cost/tokens/model, as a single `claude -p` subprocess (the
 * Claude analogue of OpenCode's promptAgent; no sessions/polling).
 */
export async function runClaudePrompt(
  handle: ClaudeCodeHandle,
  args: ClaudePromptArgs,
): Promise<PromptResult> {
  const maxWaitMs = args.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const configuredModel = handle.models[args.agent] ?? handle.defaultModel;
  // Per-role tools mirror buildOpencodeConfig (reviewers → configured set;
  // cross-cutting/verifier → read+grep; coordinator → none). maxToolCalls:0 is
  // review.ts's no-tools-fallback tripwire — deny every tool for that pass.
  const configuredTools = handle.tools[args.agent] ?? ["read", "grep", "glob"];
  const tools = args.maxToolCalls === 0 ? [] : configuredTools;
  const researchMcpConfigPath =
    args.maxToolCalls !== 0 && handle.researchAgents?.has(args.agent)
      ? handle.researchMcpConfigPath
      : undefined;
  // A soft tool-call ceiling doubles as the CLI's per-pass turn bound (the closest
  // stateless analogue of OpenCode's mid-run tool-call cap).
  const maxTurns =
    args.maxToolCalls != null && args.maxToolCalls > 0 ? args.maxToolCalls : undefined;
  // Stream safe structured activity. The heartbeat fires only after a quiet window,
  // rather than on a fixed cadence that can land immediately after a tool line.
  const heartbeatStart = Date.now();
  let lastStreamActivityAt = heartbeatStart;
  const emitActivity = (line: string): void => {
    lastStreamActivityAt = Date.now();
    args.onActivity?.(line);
  };
  const activityStream = args.onActivity
    ? createClaudeActivityStream(process.cwd(), emitActivity)
    : undefined;
  const heartbeat = args.onActivity
    ? setInterval(() => {
        if (Date.now() - lastStreamActivityAt >= CLAUDE_HEARTBEAT_MS) {
          args.onActivity?.(
            `still working… ${Math.round((Date.now() - heartbeatStart) / 1000)}s elapsed ` +
              `(no new activity for ${Math.round((Date.now() - lastStreamActivityAt) / 1000)}s)`,
          );
        }
      }, CLAUDE_HEARTBEAT_MS)
    : undefined;
  heartbeat?.unref?.();
  let result;
  try {
    result = await run(
      handle.cliPath,
      buildClaudeArgs({
        model: claudeModelId(configuredModel),
        system: args.system,
        cwd: process.cwd(),
        tools,
        researchMcpConfigPath,
        maxTurns,
        jsonSchema: args.jsonSchema,
      }),
      {
        input: args.text,
        env: handle.childEnv,
        cwd: process.cwd(),
        timeout: maxWaitMs,
        check: false,
        onStdout: activityStream?.push,
      },
    );
  } finally {
    activityStream?.finish();
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }

  // Our own deadline fired and killed the child. A killed child can't wrap up,
  // so there is no finalize salvage here.
  if (result.timedOut) {
    throw new AgentTimeoutError(args.agent, Math.round(maxWaitMs / 60000), 0, undefined, "time");
  }
  // A non-timeout signal is a crash (SIGSEGV, OOM SIGKILL, external kill), not a
  // timeout — surface it as a hard error rather than the subdivide/retry path.
  if (result.signal) {
    throw new Error(`Claude Code was killed by signal ${result.signal}`);
  }
  // Truncated output can't be parsed as JSON; report the cause plainly instead of
  // letting it fall through as a generic parse failure.
  if (result.overflowed) {
    throw new Error("claude output exceeded the 64MB buffer and was truncated");
  }

  const parsed = parseClaudeResult(result.stdout);
  const answered = pickAnsweringModel(configuredModel, parsed.modelOutputTokens);
  const model = answered
    ? claudeModelMatches(configuredModel, answered)
      ? configuredModel
      : `anthropic/${answered}`
    : configuredModel;
  const promptResult: PromptResult = {
    text: parsed.text,
    cost: parsed.cost,
    sessionID: "",
    tokens: parsed.tokens,
    model,
  };

  // A schema-requesting caller must receive the provider-validated object, never a
  // parseable-looking fallback from `result`. Claude repairs schema mismatches in
  // session first; its documented exhaustion result gets one clean-process retry in
  // claudeCodePromptAndParse. A success that omits structured_output is treated the
  // same way because it did not honor the requested provider contract.
  if (
    args.jsonSchema &&
    (parsed.structuredOutputFailure || (!parsed.isError && !parsed.hasStructuredOutput))
  ) {
    throw new ClaudeStructuredOutputError(promptResult);
  }
  if (parsed.isError) {
    const kind = classifyClaudeError(parsed.errorText);
    if (kind === "rate-limit" || kind === "usage-limit") {
      handle.rateLimit.note();
      if (kind === "usage-limit") {
        // Non-transient by construction (see usageLimitMessage): fail fast with the
        // reset time instead of retrying a cap that won't clear for hours.
        throw new Error(usageLimitMessage(parsed.errorText));
      }
      throw new Error(`Claude Code rate limit hit. (${parsed.errorText})`);
    }
    if (kind === "auth") {
      // Non-transient (see isTransientApiError): must propagate, not retry.
      throw new Error(
        `Claude Code authentication failed (${parsed.errorText}). Re-mint with ` +
          "`claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN, and check `claude auth status` / " +
          "`ecr doctor`.",
      );
    }
    const needsProcessDiagnostic =
      parsed.errorText === CLAUDE_STREAM_MISSING_RESULT ||
      parsed.errorText === CLAUDE_RESULT_MISSING_ERROR;
    throw new Error(
      needsProcessDiagnostic
        ? `${parsed.errorText} (${claudeExitDiagnostic(result)})`
        : parsed.errorText,
    );
  }

  return promptResult;
}

/**
 * Last-resort correction for a no-schema caller or disagreement between the
 * provider's JSON Schema validator and our local parser. Production parsers pass
 * `--json-schema`, so Claude Code already performs validation-aware repair inside
 * the original session before this fresh-process fallback is needed.
 */
const CLAUDE_CORRECTIVE =
  "\n\nIMPORTANT: reply with ONLY the single JSON object described above — no prose, " +
  "no code fences, no partial output.";

/**
 * Prompt via the Claude Code CLI and parse the provider-validated structured
 * result locally. Transient failures retry first; a remaining local parse failure
 * gets one fresh-process corrective as defense in depth.
 */
export async function claudeCodePromptAndParse<T>(
  handle: ClaudeCodeHandle,
  args: ClaudePromptArgs,
  parse: (text: string) => T,
): Promise<{ value: T; cost: number; truncated: boolean; tokens: TokenUsage; model?: string }> {
  let cost = 0;
  let model: string | undefined;
  const tokens: TokenUsage = {};
  const record = (result: PromptResult): void => {
    cost += result.cost;
    addTokenUsage(tokens, result.tokens);
    model = result.model ?? model;
  };

  let first: PromptResult | undefined;
  try {
    first = await withTransientRetry(`Agent "${args.agent}"`, args.onActivity, () =>
      runClaudePrompt(handle, args),
    );
    record(first);
    try {
      return { value: parse(first.text), cost, truncated: false, tokens, model };
    } catch {
      // Provider validation and local Zod validation disagreed. Retry once from a
      // clean process rather than accepting an object the trust boundary rejected.
    }
  } catch (error) {
    if (!(error instanceof ClaudeStructuredOutputError)) {
      throw error;
    }
    record(error.result);
    args.onActivity?.("structured output validation failed — retrying once");
  }

  let retry: PromptResult;
  try {
    retry = await runClaudePrompt(handle, { ...args, text: args.text + CLAUDE_CORRECTIVE });
  } catch (error) {
    if (!(error instanceof ClaudeStructuredOutputError)) {
      throw error;
    }
    record(error.result);
    throw new Error(
      `Agent "${args.agent}" could not satisfy its required JSON Schema after retries`,
    );
  }
  record(retry);
  try {
    return { value: parse(retry.text), cost, truncated: false, tokens, model };
  } catch (finalError) {
    throw new Error(
      `Agent "${args.agent}" did not return parseable JSON after retries: ${
        finalError instanceof Error ? finalError.message : String(finalError)
      }`,
    );
  }
}

/**
 * Preflight: the CLI must exist, and every configured model must be an Anthropic
 * id — a non-anthropic provider prefix (e.g. a leftover `openai/gpt-…` agent or
 * coordinator frontmatter) would otherwise fail every pass routed to it at
 * request time. Model-id validity within Anthropic is left to per-call
 * `is_error` (Claude validates at request time).
 */
export async function assertClaudeModels(
  handle: ClaudeCodeHandle,
  models: string[],
): Promise<void> {
  const foreign = [...new Set(models)].filter((model) => {
    const slash = model.indexOf("/");
    return slash > 0 && model.slice(0, slash) !== "anthropic";
  });
  if (foreign.length > 0) {
    throw new Error(
      `The claude-code engine can only run anthropic/… models, but the config resolves ` +
        `to: ${foreign.join(", ")}. Point every agent AND the coordinator (frontmatter in ` +
        `coordinator.md) at anthropic/… model ids.`,
    );
  }
  const { code } = await run(handle.cliPath, ["--version"], {
    env: handle.childEnv,
    check: false,
  });
  if (code !== 0) {
    throw new Error(MISSING_CLI_MESSAGE);
  }
}

/** A `claude auth status --text` line that indicates a usable Max/Team login. */
const SUBSCRIPTION_STATUS_RE = /max|team|subscription|logged in/i;

/**
 * Resolve the host `claude` binary the way this engine trusts it: a PATH lookup from
 * a trusted cwd (resolveOnPath, never the inherited one) and a refusal of any binary
 * that resolves INSIDE the current tree. Null when unresolved or in-tree.
 *
 * Every `claude` spawn goes through a resolved-and-checked absolute path, never a
 * bare name: the process may have chdir'd into an untrusted PR-head tree (a review)
 * and doctor/setup-auth may run inside a cloned untrusted repo, so a bare name lets a
 * PR-committed `claude` shim win the lookup and run with ambient secrets in its env.
 * startClaudeCode keeps its own inline resolution (it needs to distinguish "missing"
 * from "in-tree" for its error messages); the read-only callers use this.
 */
export async function resolveClaudeCli(): Promise<string | null> {
  const cliPath = await resolveOnPath("claude");
  if (!cliPath || pathInside(cliPath, process.cwd())) {
    return null;
  }
  return cliPath;
}

/**
 * Whether a Claude Max/Team subscription login is active locally. Shared by
 * startClaudeCode, `ecr doctor`, and `ecr setup-auth` so they agree on the
 * load-bearing regex.
 *
 * SECURITY: this may run AFTER the process has chdir'd into the untrusted PR-head
 * tree (startClaudeCode calls it mid-run), and doctor/setup-auth may themselves run
 * inside a cloned untrusted repo. So it must never spawn a BARE `claude` with the
 * inherited cwd — on Windows (and some PATH setups) that resolves the current
 * directory first, letting a PR-committed `claude` shim run with ambient secrets in
 * its env. startClaudeCode passes the CLI it already resolved and pathInside-checked
 * plus its allowlisted childEnv; doctor/setup-auth pass nothing and get the same
 * trusted resolution internally. Either way the probe runs from tmpdir(), never cwd.
 */
export async function claudeSubscriptionActive(
  cli: { cliPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const cliPath = cli.cliPath ?? (await resolveClaudeCli());
  if (!cliPath) {
    return false;
  }
  const status = await run(cliPath, ["auth", "status", "--text"], {
    check: false,
    cwd: tmpdir(),
    env: cli.env,
  });
  return status.code === 0 && SUBSCRIPTION_STATUS_RE.test(status.stdout);
}

/** A forwardable Claude credential and how the CLI takes it. */
export interface ClaudeCredential {
  value: string;
  /** "oauth" ⇒ CLAUDE_CODE_OAUTH_TOKEN; "api-key" ⇒ ANTHROPIC_API_KEY (the CLI reads either). */
  kind: "oauth" | "api-key";
}

/**
 * The forwardable Claude credential for the anthropic auth entry, or undefined.
 * Resolution order: the entry's tokenEnv value when set, else an ambient
 * CLAUDE_CODE_OAUTH_TOKEN (the var `ecr setup-auth`/`claude setup-token` export and
 * the child-env allowlist otherwise drops), else undefined (the local `claude` login
 * covers the run). Ambient ANTHROPIC_API_KEY is deliberately NOT consulted unless it
 * is the configured tokenEnv — config wins over ambient env.
 *
 * The value is classified by shape: an "sk-ant-oat…" subscription OAuth token is
 * forwarded as CLAUDE_CODE_OAUTH_TOKEN; any other value (an "sk-ant-api…" Console
 * key) as ANTHROPIC_API_KEY. Shared by startClaudeCode (what it forwards) and `ecr
 * doctor` (what it reports) so the fail-fast check and the doctor verdict never drift.
 */
export function claudeTokenCredential(
  entry: { tokenEnv?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCredential | undefined {
  const value = (entry?.tokenEnv ? env[entry.tokenEnv] : undefined) ?? env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!value) {
    return undefined;
  }
  return { value, kind: value.startsWith("sk-ant-oat") ? "oauth" : "api-key" };
}

// @ref LLP 0003#credential-resolution-and-forwarding [implements] — re-runs checkAuthEntry at the forwarding site because REVIEWER_MODEL bypasses prepareAuth/checkProviderAuth entirely
/** Start the Claude Code engine: resolve the CLI and build the subscription env. */
export async function startClaudeCode(
  config: LoadedConfig,
  research?: ResearchMcpRuntime,
): Promise<ClaudeCodeHandle> {
  const cliPath = await resolveOnPath("claude");
  if (!cliPath) {
    throw new Error(MISSING_CLI_MESSAGE);
  }
  // SECURITY backstop to resolveOnPath's trusted-cwd lookup: by the time this runs
  // the process is chdir'd into the untrusted PR-head tree, and executing a binary
  // that lives INSIDE that tree would hand the reviewed PR arbitrary code execution
  // with the engine credential in its environment. Never run an in-tree `claude`.
  if (pathInside(cliPath, process.cwd())) {
    throw new Error(
      `refusing to run a \`claude\` binary found inside the reviewed tree (${cliPath}) — ` +
        `install Claude Code on the host (npm i -g @anthropic-ai/claude-code).`,
    );
  }

  // The child env is an ALLOWLIST, never a copy of process.env: the review runs
  // over untrusted PR content, so ambient secrets (GH_TOKEN, CI tokens…) must not
  // exist in the child's environment at all — and Anthropic's documented
  // precedence lets ANTHROPIC_API_KEY/AUTH_TOKEN override the subscription OAuth,
  // so leaving them out also forces the subscription. Never log values.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) {
      childEnv[name] = process.env[name];
    }
  }
  const entry = config.auth.find((auth) => auth.provider === "anthropic");
  if (entry) {
    // Re-run the deny-list AT THE FORWARDING SITE: prepareAuth/checkProviderAuth
    // are bypassed entirely under REVIEWER_MODEL, and this is the one code path
    // that still forwards a config-named secret in that case. Without this, a
    // config could point tokenEnv at GITHUB_TOKEN (FORBIDDEN_TOKEN_ENVS) or a
    // non-anthropic provider's key and ship it to Anthropic as the bearer.
    const readiness = checkAuthEntry(entry);
    if (!readiness.ok) {
      throw new Error(readiness.detail);
    }
  }
  // Forward the resolved credential: the configured tokenEnv's value, or an ambient
  // CLAUDE_CODE_OAUTH_TOKEN when no anthropic entry names one (the var the allowlist
  // otherwise drops, so without this the token `ecr setup-auth` tells users to export
  // is a no-op and a headless run still fails). An "sk-ant-oat…" subscription token
  // goes in as CLAUDE_CODE_OAUTH_TOKEN; an Anthropic API key as ANTHROPIC_API_KEY —
  // the CLI reads either, and setting one never sets the other. See
  // claudeTokenCredential — doctor mirrors it.
  const credential = claudeTokenCredential(entry);
  if (credential) {
    if (credential.kind === "oauth") {
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = credential.value;
    } else {
      childEnv.ANTHROPIC_API_KEY = credential.value;
    }
  }

  // Fail fast with the fix in hand, before spending any pass budget: with no
  // credential of any kind AND no local `claude` login, every pass would fail
  // identically.
  if (
    !childEnv.CLAUDE_CODE_OAUTH_TOKEN &&
    !childEnv.ANTHROPIC_API_KEY &&
    !(await claudeSubscriptionActive({ cliPath, env: childEnv }))
  ) {
    throw new Error(
      "No Claude credential found: " +
        (entry?.tokenEnv
          ? `token env "${entry.tokenEnv}" is not set and no \`claude\` login is active. `
          : "no `claude` login is active. ") +
        "Run `claude setup-token` (Max/Team) and export the token, or log in with `claude`.",
    );
  }

  // The id→model map is exactly buildEngineMap's modelOf (same reviewer ids plus the
  // fixed cross-cutting / verifier / coordinator roles and their fallback), so derive
  // it there rather than re-deriving it here — one source for which model backs each id.
  const { modelOf: models } = buildEngineMap(config);
  const tools: Record<string, readonly string[]> = {};
  for (const agent of config.agents) {
    // A reviewer's configured tool map → the OpenCode tool names it enables
    // (buildClaudeArgs keeps only the read-capable subset and scopes it).
    tools[agent.id] = Object.entries(agent.tools)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
  }
  // Mirror buildOpencodeConfig's fixed roles: the cross-file and verifier passes get
  // read+grep (Glob withheld — crawling is what made them wander); the coordinator
  // consolidates findings and needs no repo tools.
  tools[CROSS_CUTTING_AGENT] = ["read", "grep"];
  tools[VERIFIER_AGENT] = ["read", "grep"];
  // No tools: the addressing PR's patch is inlined into the task, so the stack
  // verifier never reads the disk (mirrors the coordinator's empty list).
  tools[STACK_VERIFIER_AGENT] = [];
  tools["coordinator"] = [];
  const defaultModel = config.agents[0]?.model ?? config.coordinator.model;
  const researchAgents = new Set(config.agents.map((agent) => agent.id));
  researchAgents.add(CROSS_CUTTING_AGENT);

  return {
    client: undefined,
    url: "",
    close: () => {},
    // NOT the default watch file: that is the host's real OpenCode log, which this
    // engine never writes — stale 429s from unrelated OpenCode use would be counted
    // as evidence for this run. A nonexistent path keeps check() at zero; evidence
    // for this engine arrives via note() in runClaudePrompt.
    rateLimit: new RateLimitWatch(path.join(tmpdir(), `ecr-claude-${process.pid}-norate.log`)),
    engine: CLAUDE_CODE_ENGINE,
    models,
    tools,
    defaultModel,
    cliPath,
    childEnv,
    ...(research ? { researchMcpConfigPath: research.claudeConfigPath } : {}),
    researchAgents,
  };
}
