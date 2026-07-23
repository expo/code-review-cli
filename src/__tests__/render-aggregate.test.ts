import { test, expect } from "bun:test";

import {
  renderAggregateMarkdown,
  renderMarkdown,
  parseReviewState,
  parseEmbeddedFingerprints,
  commentMarker,
  worstDecision,
} from "../core/render.js";
import type { ScopeReviewResult } from "../core/render.js";
import { fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type { CoordinatorOutput, Finding } from "../core/schema.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "T",
  rationale: "r",
  evidence: "const somethingLongEnough = 1;",
  ...over,
});

const review = (over: Partial<CoordinatorOutput> = {}): CoordinatorOutput => ({
  decision: "approve",
  findings: [],
  summary: "s",
  incomplete: [],
  ...over,
});

const scope = (
  name: string,
  isDefault: boolean,
  r: Partial<CoordinatorOutput>,
): ScopeReviewResult => ({
  scope: name,
  isDefault,
  review: review(r),
});

test("worstDecision: picks the most severe across scopes", () => {
  expect(worstDecision(["approve", "approve_with_comments", "request_changes"])).toBe(
    "request_changes",
  );
  expect(worstDecision(["approve", "approve_with_comments"])).toBe("approve_with_comments");
  expect(worstDecision(["approve"])).toBe("approve");
});

test("aggregate: root marker first line, a table row + <details> per scope, worst decision at top", () => {
  const results = [
    scope("default", true, { decision: "approve", findings: [finding({ title: "D1" })] }),
    scope("www", false, {
      decision: "request_changes",
      findings: [finding({ title: "W1", severity: "critical", category: "security" })],
    }),
  ];
  const body = renderAggregateMarkdown(results, "tag", []);
  expect(body.split("\n")[0]).toBe(commentMarker("tag"));
  expect(body).toContain("**Decision:** Request changes"); // worst across scopes
  expect(body).toContain("| Scope | Decision | Findings |");
  expect(body).toContain("| default | Approve | 1 |");
  expect(body).toContain("| www | Request changes | 1 |");
  // one details block per scope, in manifest order
  expect(body.indexOf("<summary>default")).toBeLessThan(body.indexOf("<summary>www"));
  expect((body.match(/<summary>(default|www) —/g) ?? []).length).toBe(2);
});

test("aggregate: default scope uses plain fingerprints, non-default uses scoped ids; embedded block is the union", () => {
  const dFinding = finding({ title: "D", evidence: "const defaultScopedThing = 1;" });
  const wFinding = finding({ title: "W", evidence: "const wwwScopedThing = 2;" });
  const results = [
    scope("default", true, { findings: [dFinding] }),
    scope("www", false, { findings: [wFinding] }),
  ];
  const body = renderAggregateMarkdown(results, "tag", []);
  const plainId = fingerprintFinding(dFinding);
  const scopedId = scopedFingerprint("www", wFinding);
  expect(body).toContain(`id:${plainId}`);
  expect(body).toContain(`id:${scopedId}`);
  const embedded = parseEmbeddedFingerprints(body, "tag");
  expect(embedded).toContain(plainId);
  expect(embedded).toContain(scopedId);
});

test("aggregate: state round-trips through parseReviewState (scopes intact); a v1 body still parses", () => {
  const results = [
    scope("default", true, { findings: [finding({ title: "D" })] }),
    scope("www", false, { findings: [finding({ title: "W" })] }),
  ];
  const body = renderAggregateMarkdown(results, "tag", []);
  const state = parseReviewState(body, "tag");
  expect(state).not.toBeNull();
  expect(state!.scopes?.map((s) => s.scope)).toEqual(["default", "www"]);

  // A pre-routing v1 comment still parses (no scopes field).
  const v1 = renderMarkdown(review({ findings: [finding()] }), "tag");
  const v1State = parseReviewState(v1, "tag");
  expect(v1State).not.toBeNull();
  expect(v1State!.scopes).toBeUndefined();
});

test("aggregate: a default-scope finding dismissed pre-routing (plain fp) lands in Dismissed (risk 9)", () => {
  const dFinding = finding({ title: "Carried", evidence: "const carriedOverDismissal = 1;" });
  const plainFp = fingerprintFinding(dFinding);
  const results = [scope("default", true, { findings: [dFinding] })];
  const body = renderAggregateMarkdown(results, "tag", [
    { fp: plainFp, by: "me", reason: "known" },
  ]);
  expect(body).toContain("Dismissed on this PR (1)");
  expect(body).toContain(`id:${plainFp}`);
  expect(body).toContain("| default | Approve | 0 |"); // moved out of the active count
});

test("aggregate: dismissed findings survive in embedded state so /undismiss can restore them", () => {
  const dFinding = finding({ title: "DismissedOne", evidence: "const dismissedThing = 1;" });
  const kFinding = finding({ title: "KeptOne", evidence: "const keptThing = 2;" });
  const results = [scope("www", false, { findings: [dFinding, kFinding] })];
  const fp = scopedFingerprint("www", dFinding);
  const body = renderAggregateMarkdown(results, "tag", [{ fp, by: "me", reason: "known" }]);
  expect(body).toContain("Dismissed on this PR (1)");

  // The dismissed finding stays in the embedded state (and fingerprint union),
  // not just the kept one — a re-render from state must not lose it.
  const state = parseReviewState(body, "tag")!;
  expect(state.scopes![0]!.review.findings.map((f) => f.title)).toContain("DismissedOne");
  expect(parseEmbeddedFingerprints(body, "tag")).toContain(fp);

  // Round-trip: re-render from the embedded state with the dismissal removed
  // (what /undismiss does) restores the finding to the active list.
  const restored = renderAggregateMarkdown(state.scopes!, "tag", []);
  expect(restored).toContain(`id:${fp}`);
  expect(restored).toContain("| www | Approve | 2 |");
  expect(restored).not.toContain("Dismissed on this PR");
});

test('aggregate: oversized findings truncate with a "+N more" note and stay under 65k', () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    finding({
      title: `Finding ${i}`,
      severity: "critical",
      evidence: `const uniqueEvidenceNumber${i} = ${i};`,
      rationale: "x".repeat(300),
    }),
  );
  const results = [scope("www", false, { decision: "request_changes", findings: many })];
  const body = renderAggregateMarkdown(results, "tag", []);
  expect(body.length).toBeLessThan(65_000);
  expect(body).toContain("more finding(s) — see the workflow log.");
});

test("aggregate: unmatched files render as a coverage note", () => {
  const results = [scope("default", true, { findings: [] })];
  const body = renderAggregateMarkdown(results, "tag", [], undefined, {
    unmatchedFiles: ["weird/path.txt"],
  });
  expect(body).toContain("Coverage note");
  expect(body).toContain("weird/path.txt");
});
