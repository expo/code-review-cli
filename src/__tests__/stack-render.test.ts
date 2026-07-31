import { test, expect } from "bun:test";

import { renderAggregateMarkdown, renderMarkdown, parseReviewState } from "../core/render.js";
import type { ScopeReviewResult } from "../core/render.js";
import type { CoordinatorOutput, Finding } from "../core/schema.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "src/foo.ts",
  line: 1,
  title: "no test for parseX",
  rationale: "r",
  evidence: "export function parseX() {}",
  ...over,
});

const requalified = (over: Partial<Finding> = {}): Finding =>
  finding({
    title: "addressed finding",
    requalifiedBy: { prNumber: 42, file: "src/foo.test.ts", reason: "adds the test" },
    ...over,
  });

const base: CoordinatorOutput = {
  decision: "approve",
  findings: [],
  summary: "ok",
  incomplete: [],
};

test("renderMarkdown: a requalified finding moves to the addressed section with a visible audit note", () => {
  const out = renderMarkdown({ ...base, findings: [requalified()] }, "tag");
  expect(out).toContain("Addressed in stacked PRs (1)");
  expect(out).toContain("addressed in #42");
  expect(out).toContain("src/foo.test.ts");
  // Visible audit line above the fold, naming the PR.
  expect(out).toContain("marked addressed by stacked PR(s) (#42)");
  // Not rendered as an active warning.
  expect(out).not.toMatch(/###.*Warning/);
});

test("renderMarkdown: active and requalified findings split correctly", () => {
  const out = renderMarkdown(
    {
      ...base,
      decision: "approve_with_comments",
      findings: [finding({ title: "still open" }), requalified()],
    },
    "tag",
  );
  expect(out).toMatch(/###.*Warning \(1\)/); // one active warning
  expect(out).toContain("still open");
  expect(out).toContain("Addressed in stacked PRs (1)");
});

test("renderMarkdown: requalifiedBy round-trips through embedded state", () => {
  const body = renderMarkdown({ ...base, findings: [requalified()] }, "tag");
  const state = parseReviewState(body, "tag");
  expect(state?.review.findings[0]!.requalifiedBy).toEqual({
    prNumber: 42,
    file: "src/foo.test.ts",
    reason: "adds the test",
  });
});

const scope = (
  name: string,
  isDefault: boolean,
  r: Partial<CoordinatorOutput>,
): ScopeReviewResult => ({ scope: name, isDefault, review: { ...base, ...r } });

test("renderAggregateMarkdown: per-scope addressed bucket, count excludes requalified, worst decision adjusted", () => {
  const results = [
    // This scope's ONLY finding is requalified, so its decision is approve.
    scope("api", false, { decision: "approve", findings: [requalified()] }),
    scope("web", true, {
      decision: "approve_with_comments",
      findings: [finding({ title: "open one" })],
    }),
  ];
  const out = renderAggregateMarkdown(results, "tag", []);
  // Worst decision across scopes is approve_with_comments (the requalified-only scope
  // contributes approve, not request_changes).
  expect(out).toContain("**Decision:** Approve with comments");
  // The api scope's blocking count is 0 (the requalified finding is not counted).
  expect(out).toMatch(/\| api \| Approve \| 0 \|/);
  expect(out).toContain("Addressed in stacked PRs (1)");
  expect(out).toContain("marked addressed by stacked PR(s) (#42)");
});

test("renderAggregateMarkdown: requalifiedBy round-trips through aggregate embedded state", () => {
  const results = [scope("api", false, { findings: [requalified()] })];
  const body = renderAggregateMarkdown(results, "tag", []);
  const state = parseReviewState(body, "tag");
  const scopeState = state?.scopes?.find((s) => s.scope === "api");
  expect(scopeState?.review.findings[0]!.requalifiedBy?.prNumber).toBe(42);
});
