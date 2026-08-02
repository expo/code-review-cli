import { test, expect } from "bun:test";

import { adjudicateFeedback, feedbackApplied, HARD_FLOOR_CATEGORIES } from "../core/adjudicate.js";
import type { AdjudicationItem } from "../core/adjudicate.js";
import type { OpencodeHandle } from "../core/opencode.js";
import type { LoadedConfig } from "../config/schema.js";
import type { FeedbackRecord, Finding } from "../core/schema.js";

type FeedbackConfig = LoadedConfig["feedback"];

const config = (over: Partial<FeedbackConfig> = {}): FeedbackConfig => ({
  mode: "adjudicate",
  match: "both",
  dismiss: "adjudicated",
  protectedCategories: ["secrets", "security"],
  maxAdjudications: 10,
  ...over,
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

const record = (over: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  fp: "abc123",
  by: "author",
  commentId: 1,
  maintainer: false,
  applied: false,
  ...over,
});

// A handle that must never be touched — every test below drives paths that make
// zero model calls, so an access would be a bug in the code under test.
const noHandle = new Proxy(
  {},
  {
    get() {
      throw new Error("adjudicateFeedback made a model call it should not have");
    },
  },
) as OpencodeHandle;

// ---- feedbackApplied: the hard floors ----

test("feedbackApplied: dismiss:'never' (the default) never applies anything", () => {
  const c = config({ dismiss: "never" });
  expect(feedbackApplied(finding(), record({ maintainer: true }), c)).toBe(false);
  expect(feedbackApplied(finding(), record({ verdict: "accepted" }), c)).toBe(false);
});

test("feedbackApplied: mode:'off' never applies, whatever dismiss says", () => {
  const c = config({ mode: "off", dismiss: "adjudicated" });
  expect(feedbackApplied(finding(), record({ maintainer: true }), c)).toBe(false);
});

// `mode` gates the machinery, `dismiss` gates the clearing: a maintainer reply
// needs no model, so it must clear under plain annotate mode — same trust gate
// as /dismiss.
test("feedbackApplied: mode:'annotate' + dismiss:'maintainers' clears on a maintainer reply", () => {
  const c = config({ mode: "annotate", dismiss: "maintainers" });
  expect(feedbackApplied(finding(), record({ maintainer: true }), c)).toBe(true);
  expect(feedbackApplied(finding(), record({ verdict: "accepted" }), c)).toBe(false);
});

test("feedbackApplied: a critical finding is never applied, even maintainer + accepted", () => {
  const c = config({ dismiss: "adjudicated" });
  const crit = finding({ severity: "critical" });
  expect(feedbackApplied(crit, record({ maintainer: true }), c)).toBe(false);
  expect(feedbackApplied(crit, record({ verdict: "accepted" }), c)).toBe(false);
});

test("feedbackApplied: secrets/security are floored in code regardless of protectedCategories", () => {
  // Even with the protected set narrowed to empty, the code floor still holds.
  const c = config({ dismiss: "adjudicated", protectedCategories: [] });
  for (const category of HARD_FLOOR_CATEGORIES) {
    const f = finding({ category });
    expect(feedbackApplied(f, record({ maintainer: true }), c)).toBe(false);
    expect(feedbackApplied(f, record({ verdict: "accepted" }), c)).toBe(false);
  }
});

test("feedbackApplied: a configured protectedCategory can only widen the floor", () => {
  const c = config({ dismiss: "adjudicated", protectedCategories: ["quality"] });
  expect(feedbackApplied(finding({ category: "quality" }), record({ maintainer: true }), c)).toBe(
    false,
  );
});

test("feedbackApplied: a maintainer reply clears a non-floored finding, no verdict needed", () => {
  expect(feedbackApplied(finding(), record({ maintainer: true }), config())).toBe(true);
});

test("feedbackApplied: a plain author clears only under 'adjudicated' + an accepted verdict", () => {
  const author = record({ maintainer: false, verdict: "accepted" });
  expect(feedbackApplied(finding(), author, config({ dismiss: "adjudicated" }))).toBe(true);
  // A maintainers-only policy ignores the adjudicated verdict of a non-maintainer.
  expect(feedbackApplied(finding(), author, config({ dismiss: "maintainers" }))).toBe(false);
  // Accepted is required — a refuted or unset verdict does not clear.
  expect(
    feedbackApplied(finding(), record({ verdict: "refuted" }), config({ dismiss: "adjudicated" })),
  ).toBe(false);
});

// ---- adjudicateFeedback: recompute without model calls ----

test("adjudicateFeedback: mode:'off' makes no model calls and applies nothing", async () => {
  const items: AdjudicationItem[] = [
    { finding: finding(), record: record({ maintainer: true }), replyText: "trust me" },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ mode: "off" }));
  expect(out.adjudicated).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

test("adjudicateFeedback: a maintainer reply is applied with no model call (empty replyText)", async () => {
  const items: AdjudicationItem[] = [
    { finding: finding(), record: record({ maintainer: true }), replyText: "" },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.adjudicated).toBe(0);
  expect(out.records[0]!.applied).toBe(true);
});

test("adjudicateFeedback: a record with a verdict already decided is not re-judged, applied recomputed", async () => {
  const items: AdjudicationItem[] = [
    {
      finding: finding(),
      record: record({ maintainer: false, verdict: "accepted" }),
      replyText: "",
    },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.adjudicated).toBe(0);
  expect(out.records[0]!.verdict).toBe("accepted");
  expect(out.records[0]!.applied).toBe(true);
});
