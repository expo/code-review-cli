import { test, expect } from "bun:test";

import {
  isTransientApiError,
  AgentTimeoutError,
  progressFingerprint,
  stallWindowMs,
  stallAction,
  findUnknownModels,
  formatUnknownModels,
} from "../core/opencode.js";

test("classifies rate-limit / 5xx / network errors as transient", () => {
  for (const message of [
    "HTTP 429 Too Many Requests",
    "rate limit exceeded",
    "Overloaded",
    "status 503 Service Unavailable",
    "server error 500",
    "fetch failed",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "socket hang up",
  ]) {
    expect(isTransientApiError(new Error(message))).toBe(true);
  }
});

test("does not treat deterministic failures as transient", () => {
  for (const message of [
    'Agent "correctness" did not return parseable JSON after retries',
    "HTTP 400 Bad Request",
    "HTTP 401 Unauthorized",
    "HTTP 403 Forbidden",
    "invalid model id",
  ]) {
    expect(isTransientApiError(new Error(message))).toBe(false);
  }
});

test("never treats a timeout as transient (timeouts must abandon, not retry)", () => {
  // Its message mentions "timed out", but a timeout means abandon the pass.
  expect(isTransientApiError(new AgentTimeoutError("correctness", 15))).toBe(false);
});

test("tolerates non-Error thrown values", () => {
  expect(isTransientApiError("429 rate limit")).toBe(true);
  expect(isTransientApiError(undefined)).toBe(false);
  expect(isTransientApiError({ nope: true })).toBe(false);
});

// ---- stall detection (see STALL_MS in opencode.ts) ----
//
// Motivating incident: eas-cli#4084, where the cross-file pass ran 7 reads in its
// first 6 seconds and then sat silent for 25 minutes with ZERO tokens recorded. The
// fingerprint is what lets the poll loop tell that apart from a slow investigation.

/** The shape pollForCompletion sees: an in-progress assistant message. */
function message(parts: unknown[], tokens?: Record<string, unknown>): any {
  return { info: { role: "assistant", cost: 0, tokens }, parts };
}

test("fingerprint is stable while a reply is unchanged (a wedged request)", () => {
  const wedged = () =>
    message([{ type: "tool", callID: "c1", state: { status: "completed" } }], {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
  // Two independent polls of the same untouched message must agree, or the watchdog
  // would keep resetting itself and never fire.
  expect(progressFingerprint(wedged())).toBe(progressFingerprint(wedged()));
});

test("fingerprint changes on a new tool call", () => {
  const before = message([{ type: "tool", callID: "c1", state: { status: "completed" } }]);
  const after = message([
    { type: "tool", callID: "c1", state: { status: "completed" } },
    { type: "tool", callID: "c2", state: { status: "running" } },
  ]);
  expect(progressFingerprint(after)).not.toBe(progressFingerprint(before));
});

test("fingerprint changes as a tool advances pending → running → completed", () => {
  const at = (status: string) => message([{ type: "tool", callID: "c1", state: { status } }]);
  const seen = new Set(["pending", "running", "completed"].map((s) => progressFingerprint(at(s))));
  expect(seen.size).toBe(3);
});

test("fingerprint changes as text and reasoning stream in", () => {
  const short = message([{ type: "text", text: "abc" }]);
  const longer = message([{ type: "text", text: "abcdef" }]);
  expect(progressFingerprint(longer)).not.toBe(progressFingerprint(short));

  const reasoning = message([{ type: "reasoning", text: "hmm" }]);
  const moreReasoning = message([{ type: "reasoning", text: "hmm, and" }]);
  expect(progressFingerprint(moreReasoning)).not.toBe(progressFingerprint(reasoning));
});

test("fingerprint changes on token growth alone (no visible parts)", () => {
  // A reply can burn reasoning tokens without emitting a part; that is still progress.
  const before = message([], { input: 100, output: 0, reasoning: 0, cache: { read: 0 } });
  const after = message([], { input: 100, output: 0, reasoning: 512, cache: { read: 0 } });
  expect(progressFingerprint(after)).not.toBe(progressFingerprint(before));
});

test("fingerprint tolerates a message with no parts or tokens", () => {
  expect(progressFingerprint({})).toBe(progressFingerprint({}));
  expect(typeof progressFingerprint({})).toBe("string");
});

test("AgentTimeoutError distinguishes a stall from non-convergence", () => {
  const stalled = new AgentTimeoutError("cross-cutting", 25, 0, undefined, "stall");
  expect(stalled.reason).toBe("stall");
  expect(stalled.message).toContain("silent");
  // A stall is still not retryable by the transient-error path (promptAgent already
  // retried it once from a clean session).
  expect(isTransientApiError(stalled)).toBe(false);

  const wandered = new AgentTimeoutError("correctness", 15);
  expect(wandered.reason).toBe("time");
  expect(wandered.message).toContain("timed out");
});

test("stall window never outlasts the pass it guards", () => {
  const MIN = 60_000;
  // Long passes (chunk 15m, the elastic cross-file pass): the full 4m window.
  expect(stallWindowMs(15 * MIN)).toBe(4 * MIN);
  expect(stallWindowMs(50 * MIN)).toBe(4 * MIN);
  // Short passes get a proportional window instead of none: the 3m verifier and the
  // 4m no-tools fallback would otherwise hit their deadline first and go unprotected.
  expect(stallWindowMs(3 * MIN)).toBe(1.5 * MIN);
  expect(stallWindowMs(4 * MIN)).toBe(2 * MIN);
  // Floored, so a very short cap still allows a slow first token.
  expect(stallWindowMs(20_000)).toBe(30_000);
  // Invariant across the range: the watchdog fires before the deadline, never after.
  for (const cap of [30_000, MIN, 3 * MIN, 10 * MIN, 60 * MIN]) {
    expect(stallWindowMs(cap)).toBeLessThanOrEqual(Math.max(cap, 30_000));
  }
});

test("a stall is retried exactly once, and only with budget left to land it", () => {
  const MIN = 60_000;
  // First stall with most of the window left → clean-slate retry.
  expect(stallAction(0, 20 * MIN)).toBe("retry");
  // Stalled again → salvage. A second wedged attempt would spend the rest of the
  // pass's window, which is precisely the failure this mechanism exists to end.
  expect(stallAction(1, 20 * MIN)).toBe("soft-land");
  expect(stallAction(2, 20 * MIN)).toBe("soft-land");
  // Too little left for a fresh attempt to plausibly finish → salvage now.
  expect(stallAction(0, 2 * MIN)).toBe("soft-land");
  expect(stallAction(0, 0)).toBe("soft-land");
  // The threshold must exceed one full stall window, or the retry could only ever
  // stall again before it had a chance to produce anything.
  expect(stallAction(0, 4 * MIN)).toBe("soft-land");
  expect(stallAction(0, 6 * MIN)).toBe("retry");
});

// ---- model preflight ----
//
// A wrong model id hits every pass identically, so it must be caught ONCE up front
// rather than N times as indistinguishable coverage gaps. Motivating failure: a stale
// global `opencode` rejecting `anthropic/claude-opus-4-8` with "Did you mean:
// claude-opus-4-8" — a real config/version problem buried in per-pass noise.

const AVAILABLE = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5.5"],
};

test("resolvable models produce no complaints", () => {
  expect(
    findUnknownModels(["anthropic/claude-sonnet-5", "anthropic/claude-opus-4-8"], AVAILABLE),
  ).toEqual([]);
});

test("unknown provider is reported with the providers that do exist", () => {
  const [problem] = findUnknownModels(["bedrock/claude-sonnet-5"], AVAILABLE);
  expect(problem?.reason).toBe("provider");
  expect(problem?.suggestions).toEqual(["anthropic", "openai"]);
});

test("unknown model suggests near matches from that provider", () => {
  const [problem] = findUnknownModels(["anthropic/claude-sonnet-9"], AVAILABLE);
  expect(problem?.reason).toBe("model");
  // Prefix-matched against the requested id, so the suggestions are the plausible ones.
  expect(problem?.suggestions).toEqual(["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5"]);
});

test("a bare model id (no provider) is reported, not silently accepted", () => {
  // "claude-sonnet-5" alone is not a valid OpenCode id; it must be provider/model.
  const [problem] = findUnknownModels(["claude-sonnet-5"], AVAILABLE);
  expect(problem?.reason).toBe("provider");
});

test("only the FIRST slash splits provider from model", () => {
  // openrouter-style ids contain a slash in the model half; splitting on every slash
  // would make a valid id look unknown.
  const available = { openrouter: ["anthropic/claude-sonnet-5"] };
  expect(findUnknownModels(["openrouter/anthropic/claude-sonnet-5"], available)).toEqual([]);
});

test("duplicate model ids are reported once", () => {
  const problems = findUnknownModels(["x/y", "x/y", "x/y"], AVAILABLE);
  expect(problems).toHaveLength(1);
});

test("a refused credential blames the credential, not the model id", () => {
  const unknown = findUnknownModels(
    ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4-8"],
    { openai: ["gpt-5.5"] },
    "anthropic",
  );
  expect(unknown.every((entry) => entry.reason === "credential")).toBe(true);
  const text = formatUnknownModels(unknown, {
    mode: "oauth",
    provider: "anthropic",
    tokenEnv: "ANTHROPIC_OAUTH_API_KEY",
  });
  // Rate limiting must be offered FIRST: a throttled subscription credential is
  // refused exactly like an invalid one, and re-issuing the token does not help.
  expect(text).toContain("RATE LIMITED");
  expect(text.indexOf("RATE LIMITED")).toBeLessThan(text.indexOf("wrong for the mode"));
  expect(text).toContain("429 = rate limited");
  expect(text).toContain("ANTHROPIC_OAUTH_API_KEY");
  // …and it must NOT read as "your model id is wrong", which is the wrong hunt.
  expect(text).not.toContain("no such model");
});

test("a credentialed provider that IS present is not flagged", () => {
  expect(
    findUnknownModels(
      ["anthropic/claude-sonnet-5"],
      { anthropic: ["claude-sonnet-5"] },
      "anthropic",
    ),
  ).toEqual([]);
});

test("the error text names the fix, not just the failure", () => {
  const text = formatUnknownModels(findUnknownModels(["anthropic/claude-sonnet-9"], AVAILABLE));
  expect(text).toContain("anthropic/claude-sonnet-9");
  expect(text).toContain("claude-sonnet-5");
  expect(text).toContain("config.jsonc");
  expect(text).toContain("ecr doctor");
});
