import { createOpencode } from "@opencode-ai/sdk";

import type { LoadedConfig } from "../config/schema.js";
import { toolMap } from "./tools.js";
import { errorMessage, sleep } from "./util.js";

export interface OpencodeHandle {
  client: any;
  url: string;
  close: () => void;
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
  agent["coordinator"] = {
    description: "Consolidates specialist findings into one decision.",
    mode: "all",
    model: config.coordinator.model,
    temperature: config.coordinator.temperature,
    prompt:
      "You are the review coordinator. Follow the user message exactly and return only the requested JSON.",
    tools: COORDINATOR_TOOLS,
  };
  return { $schema: "https://opencode.ai/config.json", agent };
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

/** Start an in-process OpenCode server with the given inline config. */
export async function startOpencode(config: unknown): Promise<OpencodeHandle> {
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    config: config as any,
  });
  return { client, url: server.url, close: () => server.close() };
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
// Only retry when enough of the pass's budget remains for the fresh attempt to
// plausibly finish; otherwise go straight to the soft landing.
const STALL_RETRY_MIN_REMAINING_MS = STALL_MS + 60 * 1000;

/**
 * What to do about a stalled attempt: start over from a clean session, or stop and
 * try to salvage findings. Exactly ONE retry, and only with enough budget left for it
 * to land — a second wedged attempt would just spend the rest of the pass's window,
 * which is the failure this whole mechanism exists to end. Exported for tests.
 */
export function stallAction(attempt: number, remainingMs: number): "retry" | "soft-land" {
  return attempt === 0 && remainingMs > STALL_RETRY_MIN_REMAINING_MS ? "retry" : "soft-land";
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
      if (error instanceof NoProgress) {
        await abortQuietly(handle, session.id);
        absorb(error);
        const remaining = deadline - Date.now();
        if (stallAction(attempt, remaining) === "retry") {
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

const CORRECTIVE =
  "\n\nIMPORTANT: your previous reply could not be parsed. Reply with ONLY the single " +
  "JSON object described above — no prose, no code fences, no partial output.";

// Budget for a corrective "re-emit the JSON" reply — no fresh investigation, so
// it should return almost immediately.
const CORRECTIVE_WAIT_MS = 2 * 60 * 1000;

/** Backoff (ms) before the 2nd and 3rd attempt of a transient-failing model call. */
const TRANSIENT_BACKOFF_MS = [2_000, 8_000];

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
async function withTransientRetry<T>(
  label: string,
  onActivity: ((line: string) => void) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const waitMs = TRANSIENT_BACKOFF_MS[attempt];
      if (waitMs === undefined || !isTransientApiError(error)) {
        throw error;
      }
      onActivity?.(
        `${label}: transient API error (${errorMessage(error)}); retry ${attempt + 1}/${
          TRANSIENT_BACKOFF_MS.length
        } in ${Math.round(waitMs / 1000)}s`,
      );
      await sleep(waitMs);
    }
  }
}

/**
 * Prompt an agent and parse its reply. On a JSON-parse failure, first retry in
 * the SAME session: the model still holds all the file context it read, so the
 * corrective is a cache read and a cheap re-emit — and better for recall than
 * re-investigating from scratch (the usual failure is a truncated/malformed reply
 * after a sound investigation). Only if that also fails do we fall back to a fresh
 * session as a clean-slate last resort. A timeout is NOT a parse failure:
 * promptAgent throws AgentTimeoutError, which propagates so the caller abandons
 * the task instead of retrying a non-convergent run.
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
  parse: (text: string) => T,
): Promise<{ value: T; cost: number; truncated: boolean; tokens: TokenUsage }> {
  let cost = 0;
  let truncated = false;
  const tokens: TokenUsage = {};
  const record = (result: PromptResult): void => {
    cost += result.cost;
    truncated = truncated || (result.truncated ?? false);
    addTokenUsage(tokens, result.tokens);
  };

  const first = await withTransientRetry(`Agent "${args.agent}"`, args.onActivity, () =>
    promptAgent(handle, args),
  );
  record(first);
  try {
    return { value: parse(first.text), cost, truncated, tokens };
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
      return { value: parse(retry.text), cost, truncated, tokens };
    } catch {
      // Fresh-session last resort: a clean slate for a genuinely confused run.
      const fresh = await promptAgent(handle, {
        ...args,
        text: args.text + CORRECTIVE,
        finalizeOnTimeout: false,
      });
      record(fresh);
      try {
        return { value: parse(fresh.text), cost, truncated, tokens };
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
