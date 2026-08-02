import { test, expect } from "bun:test";

import { mergeAggregateFeedback } from "../commands/ci.js";
import type { ScopeReviewResult } from "../core/render.js";
import type { ReviewRunResult } from "../core/review.js";
import { scopedFingerprint } from "../core/schema.js";
import type { FeedbackRecord, Finding } from "../core/schema.js";
import type { LoadedConfig } from "../config/schema.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "T",
  rationale: "r",
  ...over,
});

const record = (over: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  fp: "fp",
  by: "author",
  commentId: 1,
  maintainer: false,
  applied: false,
  ...over,
});

/** The head this run reviews, and the one a stored verdict was decided against. */
const HEAD_SHA = "1111111111111111111111111111111111111111";
const OLD_HEAD_SHA = "2222222222222222222222222222222222222222";

const feedbackConfig: LoadedConfig["feedback"] = {
  mode: "adjudicate",
  match: "both",
  dismiss: "adjudicated",
  protectedCategories: [],
  maxAdjudications: 10,
};

/** A scope result whose seam SUCCEEDED this run: `review.feedback` is a real
 * (possibly empty) array. */
function seamOkScope(
  scope: string,
  findings: Finding[],
  feedback: FeedbackRecord[],
): ScopeReviewResult {
  const review: ReviewRunResult = {
    decision: "approve_with_comments",
    findings,
    summary: "s",
    incomplete: [],
    feedback,
  };
  return { scope, isDefault: false, review };
}

/** A scope result whose seam FAILED this run (matchAdjudicationItems threw, e.g. a
 * transient GitHub fetch error): `review.feedback` is absent, exactly like
 * runReview leaves it on a caught feedback-step error. */
function seamFailedScope(scope: string, findings: Finding[]): ScopeReviewResult {
  return {
    scope,
    isDefault: false,
    review: { decision: "approve_with_comments", findings, summary: "s", incomplete: [] },
  };
}

test("a scope whose seam failed this run preserves prior records for its still-present findings", () => {
  // Finding 9c274a62974b: a transient GitHub fetch error inside matchAdjudicationItems
  // must never delete a scope's stored reply attribution/verdict.
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [record({ fp, by: "author1", maintainer: true })];
  const results = [seamFailedScope("api", [f1])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  const kept = merged.find((r) => r.fp === fp);
  expect(kept).toBeDefined();
  expect(kept!.by).toBe("author1");
  expect(kept!.maintainer).toBe(true);
});

test("a scope whose seam succeeded drops a stale record when no fresh reply exists", () => {
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [record({ fp, by: "author1" })];
  // Seam ran fine and returned zero records (e.g. the reply was deleted).
  const results = [seamOkScope("api", [f1], [])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  expect(merged.find((r) => r.fp === fp)).toBeUndefined();
});

test("a scope whose seam succeeded replaces the prior record with the fresh one", () => {
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [record({ fp, by: "author1", verdict: "refuted" })];
  const fresh = record({ fp, by: "author2", verdict: "accepted", commentId: 2 });
  const results = [seamOkScope("api", [f1], [fresh])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  const kept = merged.find((r) => r.fp === fp);
  expect(kept?.by).toBe("author2");
  expect(kept?.verdict).toBe("accepted");
});

test("only the failed scope falls back; a sibling scope's successful seam still authoritative", () => {
  const apiFinding = finding({ file: "api.ts", title: "Api issue" });
  const webFinding = finding({ file: "web.ts", title: "Web issue" });
  const apiFp = scopedFingerprint("api", apiFinding);
  const webFp = scopedFingerprint("web", webFinding);
  const prior = [record({ fp: apiFp, by: "apiAuthor" }), record({ fp: webFp, by: "webAuthor" })];
  const results = [
    seamFailedScope("api", [apiFinding]),
    // web's seam ran fine and found no records this run (reply gone).
    seamOkScope("web", [webFinding], []),
  ];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  expect(merged.find((r) => r.fp === apiFp)?.by).toBe("apiAuthor");
  expect(merged.find((r) => r.fp === webFp)).toBeUndefined();
});

test("a carried-over scope (partial --scopes run) not in `results` keeps its prior records untouched", () => {
  const carriedFinding = finding({ file: "docs.ts", title: "Docs issue" });
  const docsFp = scopedFingerprint("docs", carriedFinding);
  const prior = [record({ fp: docsFp, by: "docsAuthor" })];
  // `results` only contains the freshly re-reviewed scope this run ("api"); "docs"
  // was carried over from the prior aggregate state via mergePartialAggregate and
  // is absent from `results`, so its fingerprints must never be treated as fresh.
  const apiFinding = finding({ file: "api.ts", title: "Api issue" });
  const results = [seamOkScope("api", [apiFinding], [])];
  const finalResults: ScopeReviewResult[] = [...results, seamOkScope("docs", [carriedFinding], [])];
  const merged = mergeAggregateFeedback(results, finalResults, prior, feedbackConfig, HEAD_SHA);
  expect(merged.find((r) => r.fp === docsFp)?.by).toBe("docsAuthor");
});

test("a stale per-scope feedback copy on a carried-over scope never overrides a newer top-level record (undismiss revert)", () => {
  // Finding stale-scope-feedback: a full run cleared finding F on scope www, storing
  // R1 (applied:true) both at the top level AND inside www's per-scope review.feedback.
  // A human /undismiss rewrote ONLY the top-level record to R2 (applied:false, pinned).
  // A later `--scopes api` run carries www over via mergePartialAggregate — its review
  // still holds the stale R1. The merge must keep R2 (from `prior`), never re-inject R1.
  const wwwFinding = finding({ file: "www.ts", title: "Www issue" });
  const wwwFp = scopedFingerprint("www", wwwFinding);
  // Top-level prior state = the human-overridden record.
  const r2 = record({
    fp: wwwFp,
    by: "author1",
    applied: false,
    unclearedByHuman: true,
    maintainer: true,
  });
  const prior = [r2];
  // This run freshly reviews only "api"; www is carried over and still embeds the
  // stale R1 (applied:true, no pin) inside its per-scope review.feedback.
  const apiFinding = finding({ file: "api.ts", title: "Api issue" });
  const results = [seamOkScope("api", [apiFinding], [])];
  const staleR1 = record({ fp: wwwFp, by: "author1", applied: true, maintainer: true });
  const finalResults: ScopeReviewResult[] = [
    ...results,
    seamOkScope("www", [wwwFinding], [staleR1]),
  ];
  const merged = mergeAggregateFeedback(results, finalResults, prior, feedbackConfig, HEAD_SHA);
  const kept = merged.find((r) => r.fp === wwwFp);
  expect(kept).toBeDefined();
  // The human override survives: pinned and un-applied, not re-hidden by the stale copy.
  expect(kept!.unclearedByHuman).toBe(true);
  expect(kept!.applied).toBe(false);
});

// Finding agg-verdict-head: the reporter binds a verdict to the source it judged, and
// this path has to honor the same rule. A scope whose seam threw keeps its prior
// record, feedbackApplied never looks at sourceSha, and reportAggregate skips
// computeFeedback when it is handed explicit records — so without the check here the
// finding renders as cleared against source the verdict never saw.
test("a prior verdict decided against an older head is dropped, not re-applied", () => {
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [
    record({
      fp,
      by: "author",
      author: true,
      verdict: "accepted",
      reason: "pre-existing",
      sourceSha: OLD_HEAD_SHA,
      applied: true,
    }),
  ];
  // The scope was re-reviewed but its seam threw, so its fingerprints are not fresh and
  // the prior record is carried.
  const results = [seamFailedScope("api", [f1])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  const kept = merged.find((r) => r.fp === fp);
  expect(kept).toBeDefined();
  // The reply attribution survives (the reply is still there); the decision does not.
  expect(kept!.by).toBe("author");
  expect(kept!.verdict).toBeUndefined();
  expect(kept!.reason).toBeUndefined();
  expect(kept!.sourceSha).toBeUndefined();
  expect(kept!.applied).toBe(false);
});

test("a prior verdict decided against the head under review still clears the finding", () => {
  // The control for the test above: same record, same path, only the source matches —
  // so the drop is about the head moving, not about carrying records at all.
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [
    record({ fp, by: "author", author: true, verdict: "accepted", sourceSha: HEAD_SHA }),
  ];
  const results = [seamFailedScope("api", [f1])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  expect(merged.find((r) => r.fp === fp)?.verdict).toBe("accepted");
  expect(merged.find((r) => r.fp === fp)?.applied).toBe(true);
});

test("a prior verdict never carries when this run has no head SHA", () => {
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [
    record({ fp, by: "author", author: true, verdict: "accepted", sourceSha: HEAD_SHA }),
  ];
  const results = [seamFailedScope("api", [f1])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, undefined);
  expect(merged.find((r) => r.fp === fp)?.verdict).toBeUndefined();
  expect(merged.find((r) => r.fp === fp)?.applied).toBe(false);
});

test("a verdict-less carried record (maintainer reply) is untouched by a head change", () => {
  const f1 = finding({ file: "api.ts", title: "Issue" });
  const fp = scopedFingerprint("api", f1);
  const prior = [record({ fp, by: "maint", maintainer: true, applied: true })];
  const results = [seamFailedScope("api", [f1])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  expect(merged.find((r) => r.fp === fp)?.applied).toBe(true);
});

test("applied is recomputed under the current config, not carried as a stored fact", () => {
  // A critical finding can never be cleared by a reply, even a stored `applied: true`
  // from a run under a looser config — the hard floor is re-derived every time.
  const critical = finding({ file: "sec.ts", title: "Secret leak", severity: "critical" });
  const fp = scopedFingerprint("api", critical);
  const prior = [record({ fp, by: "author1", applied: true, maintainer: true })];
  const results = [seamFailedScope("api", [critical])];
  const merged = mergeAggregateFeedback(results, results, prior, feedbackConfig, HEAD_SHA);
  expect(merged.find((r) => r.fp === fp)?.applied).toBe(false);
});
