import { test, expect } from "bun:test";

import {
  chunkByLines,
  applyReviewPolicy,
  runGrowableQueue,
  decisionAfterVerification,
  reconcileSummary,
  isAuthError,
  formatUsageSummary,
  renderUsageMarkdown,
  effectiveConcurrency,
} from "../core/review.js";
import type { LoadedConfig } from "../config/schema.js";
import type { PatchWorkspaceFile } from "../core/noise.js";
import type { CoordinatorOutput, Finding } from "../core/schema.js";

const wf = (p: string, changedLines: number): PatchWorkspaceFile => ({
  path: p,
  patchPath: "/x",
  status: "M",
  patch: "",
  changedLines,
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "T",
  rationale: "r",
  ...over,
});

test("chunkByLines: splits by maxChangedLines", () => {
  const chunks = chunkByLines([wf("a", 600), wf("b", 600), wf("c", 600)], 1000, 20);
  expect(chunks.map((c) => c.map((f) => f.path))).toEqual([["a"], ["b"], ["c"]]);
});

test("chunkByLines: caps by maxFiles", () => {
  const files = Array.from({ length: 25 }, (_, i) => wf(`f${i}`, 1));
  const chunks = chunkByLines(files, 10_000, 20);
  expect(chunks.length).toBe(2);
  expect(chunks[0]!.length).toBe(20);
  expect(chunks[1]!.length).toBe(5);
});

test("chunkByLines: a single over-budget file is its own chunk", () => {
  const chunks = chunkByLines([wf("big", 5000), wf("small", 10)], 1000, 20);
  expect(chunks.map((c) => c.map((f) => f.path))).toEqual([["big"], ["small"]]);
});

test("applyReviewPolicy: drops suggestions, sorts by severity", () => {
  const out: CoordinatorOutput = {
    decision: "request_changes",
    findings: [
      finding({ severity: "suggestion" }),
      finding({ severity: "warning" }),
      finding({ severity: "critical" }),
    ],
    summary: "s",
    incomplete: [],
  };
  const result = applyReviewPolicy(out, { includeSuggestions: false });
  expect(result.findings.map((f) => f.severity)).toEqual(["critical", "warning"]);
});

test("applyReviewPolicy: strips the __overall_pr_risk__ handoff even with includeSuggestions", () => {
  const out: CoordinatorOutput = {
    decision: "request_changes",
    findings: [
      finding({ severity: "suggestion", title: "__overall_pr_risk__" }),
      finding({ severity: "suggestion", title: "a real suggestion" }),
      finding({ severity: "critical" }),
    ],
    summary: "s",
    incomplete: [],
  };
  // includeSuggestions:true removes the severity backstop — the handoff must
  // still never reach the PR comment, since it is prompt metadata, not a defect.
  const result = applyReviewPolicy(out, { includeSuggestions: true });
  expect(result.findings.map((f) => f.title)).toEqual(["T", "a real suggestion"]);
});

test("applyReviewPolicy: a lone risk handoff leaves no findings and approves", () => {
  const result = applyReviewPolicy(
    {
      decision: "approve_with_comments",
      findings: [finding({ severity: "suggestion", title: "  __overall_pr_risk__  " })],
      summary: "s",
      incomplete: [],
    },
    { includeSuggestions: true },
  );
  expect(result.findings).toEqual([]);
  expect(result.decision).toBe("approve");
});

test("applyReviewPolicy: approve_with_comments + no findings → approve", () => {
  const result = applyReviewPolicy(
    { decision: "approve_with_comments", findings: [], summary: "", incomplete: [] },
    { includeSuggestions: false },
  );
  expect(result.decision).toBe("approve");
});

test("runGrowableQueue: runs every ELEMENT once, bounded (guards the index-vs-element FP)", async () => {
  const seen: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await runGrowableQueue([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    inFlight--;
  });
  expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]); // the values, not indices 0..4
  expect(maxInFlight).toBeLessThanOrEqual(2);
});

test("runGrowableQueue: processes items enqueued DURING the run (subdivision), still bounded", async () => {
  const seen: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await runGrowableQueue([1, 2, 3], 2, async (n, enqueue) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    // Item 3 "times out" and subdivides into two smaller units mid-run.
    if (n === 3) {
      enqueue(30);
      enqueue(31);
    }
    inFlight--;
  });
  expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 30, 31]);
  expect(maxInFlight).toBeLessThanOrEqual(2);
});

test("reconcileSummary: replaces summary when everything was dropped", () => {
  const out = reconcileSummary("Three critical issues: a, b, c.", 0);
  expect(out).toContain("no issues remain");
  expect(out).not.toContain("Three critical"); // stale text is gone
});

test("reconcileSummary: prepends a caveat when some findings remain", () => {
  const out = reconcileSummary("Three critical issues: a, b, c.", 2);
  expect(out).toContain("some findings were removed"); // honest caveat
  expect(out).toContain("Three critical issues: a, b, c."); // original prose kept below
});

test("decisionAfterVerification: re-derives after drops", () => {
  expect(decisionAfterVerification("request_changes", [])).toBe("approve");
  expect(decisionAfterVerification("request_changes", [finding({ severity: "warning" })])).toBe(
    "approve_with_comments",
  );
  expect(decisionAfterVerification("request_changes", [finding({ severity: "critical" })])).toBe(
    "request_changes",
  );
});

test("isAuthError flags provider auth/permission failures", () => {
  for (const message of [
    "HTTP 401 Unauthorized",
    "status 403 Forbidden",
    "authentication_error: invalid x-api-key",
    "permission denied for this model",
    "Invalid API key provided",
    "the OAuth token has expired",
    "missing api key",
  ]) {
    expect(isAuthError(new Error(message))).toBe(true);
  }
});

test("isAuthError does not flag non-auth failures", () => {
  for (const message of [
    "HTTP 429 Too Many Requests",
    "server error 500",
    "did not return parseable JSON after retries",
    "ECONNRESET",
    "request timed out",
  ]) {
    expect(isAuthError(new Error(message))).toBe(false);
  }
});

test("formatUsageSummary reports token + cache totals (and cost when present)", () => {
  const s = formatUsageSummary(
    { input: 1200, output: 340, reasoning: 50, cache: { read: 108_000, write: 900 } },
    0.0123,
  );
  expect(s).toContain("input 1200");
  expect(s).toContain("output 340");
  expect(s).toContain("reasoning 50");
  expect(s).toContain("cache read 108000");
  expect(s).toContain("cache write 900");
  expect(s).toContain("$0.0123");
});

test("formatUsageSummary omits cost when zero and reasoning when absent", () => {
  const s = formatUsageSummary({ input: 10, output: 5 }, 0);
  expect(s).toContain("cache read 0");
  expect(s).not.toContain("reasoning");
  expect(s).not.toContain("cost");
});

test("renderUsageMarkdown emits one row per pass with its model, a total, and the cache hit rate", () => {
  const s = renderUsageMarkdown(
    {
      correctness: { input: 1000, output: 200, cache: { read: 9000, write: 500 } },
      coordinator: { input: 500, output: 100, cache: { read: 0, write: 400 } },
    },
    { correctness: 0.01, coordinator: 0.002 },
    { input: 1500, output: 300, cache: { read: 9000, write: 900 } },
    0.012,
    { correctness: "openai/gpt-5.5" },
  );
  // Each pass names the model that ACTUALLY answered it; a pass the server never
  // reported a model for shows "—" rather than pretending to know.
  expect(s).toContain("| correctness | openai/gpt-5.5 | 1000 | 200 | 9000 | 500 | $0.0100 |");
  expect(s).toContain("| coordinator | — | 500 | 100 | 0 | 400 | $0.0020 |");
  expect(s).toContain("| **total** |  | 1500 | 300 | 9000 | 900 | $0.0120 |");
  // 9000 / (9000 + 1500) ≈ 86%
  expect(s).toContain("**86%**");
});

test("renderUsageMarkdown omits the hit rate when no prompt tokens were used", () => {
  const s = renderUsageMarkdown({}, {}, {}, 0);
  expect(s).not.toContain("hit rate");
});

// ---- auth-mode-aware concurrency ----

test("effectiveConcurrency: explicit config wins; subscription defaults lower", () => {
  // buildEngineMap reads agents + coordinator, so give each config a model.
  const cfg = (chunk: object, auth: object[], model = "openai/gpt-5.5"): LoadedConfig =>
    ({
      chunk,
      auth,
      agents: [{ id: "a", model }],
      coordinator: { model },
    }) as unknown as LoadedConfig;
  // An explicit value always wins, whatever the auth mode.
  expect(
    effectiveConcurrency(cfg({ concurrency: 8 }, [{ mode: "oauth", provider: "openai" }])),
  ).toBe(8);
  // A subscription (oauth) credential defaults lower: one account handles six
  // parallel streams poorly, and several PRs may share the credential.
  expect(effectiveConcurrency(cfg({}, [{ mode: "oauth", provider: "openai" }]))).toBe(3);
  expect(
    effectiveConcurrency(
      cfg({}, [
        { mode: "oauth", provider: "openai" },
        { mode: "api-key", provider: "openai-api", upstream: "openai" },
      ]),
    ),
  ).toBe(3);
  // Pure API-key runs keep the full default.
  expect(effectiveConcurrency(cfg({}, [{ mode: "api-key", provider: "openai" }]))).toBe(6);
});

test("effectiveConcurrency: the claude engine caps on an OAUTH credential, not an api-key one", () => {
  const cfg = (auth: object[]): LoadedConfig =>
    ({
      chunk: {},
      auth,
      agents: [{ id: "a", model: "anthropic/claude-opus-5" }],
      coordinator: { model: "anthropic/claude-opus-5" },
    }) as unknown as LoadedConfig;
  const oat = `sk-ant-oat01-${"x".repeat(95)}`;
  const apiKey = `sk-ant-api03-${"y".repeat(95)}`;
  // Login fallback (no forwardable token) → subscription → cap 3.
  expect(effectiveConcurrency(cfg([{ mode: "api-key", provider: "anthropic" }]), {})).toBe(3);
  // An "sk-ant-oat…" subscription token → cap 3.
  expect(
    effectiveConcurrency(cfg([{ mode: "api-key", provider: "anthropic", tokenEnv: "TOK" }]), {
      TOK: oat,
    }),
  ).toBe(3);
  // An Anthropic API key is metered per-request → NO cap (full 6).
  expect(
    effectiveConcurrency(cfg([{ mode: "api-key", provider: "anthropic", tokenEnv: "TOK" }]), {
      TOK: apiKey,
    }),
  ).toBe(6);
  // An explicit config value still wins over the cap.
  const explicit = cfg([{ mode: "api-key", provider: "anthropic" }]);
  explicit.chunk = { concurrency: 5 } as never;
  expect(effectiveConcurrency(explicit, {})).toBe(5);
});
