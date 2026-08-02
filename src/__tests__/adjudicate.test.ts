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
  author: false,
  applied: false,
  ...over,
});

// A handle that must never be touched — every test below drives paths that make
// zero model calls, so an access would be a bug in the code under test.
// adjudicateFeedback catches per-item errors (it fails open), so this throw is NOT
// visible as a rejection: every test using noHandle must assert `failed === 0`, or an
// unwanted model call would be silently swallowed and the test would still pass.
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

test("feedbackApplied: the PR author clears only under 'adjudicated' + an accepted verdict", () => {
  const author = record({ maintainer: false, author: true, verdict: "accepted" });
  expect(feedbackApplied(finding(), author, config({ dismiss: "adjudicated" }))).toBe(true);
  // A maintainers-only policy ignores the adjudicated verdict of a non-maintainer.
  expect(feedbackApplied(finding(), author, config({ dismiss: "maintainers" }))).toBe(false);
  // Accepted is required — a refuted or unset verdict does not clear.
  expect(
    feedbackApplied(
      finding(),
      record({ author: true, verdict: "refuted" }),
      config({ dismiss: "adjudicated" }),
    ),
  ).toBe(false);
});

// The security floor: only the PR author (or a maintainer) may clear via a reply.
// A random third-party commenter's rebuttal — even one a model accepts — never clears.
test("feedbackApplied: a third-party commenter never clears, even with an accepted verdict", () => {
  const thirdParty = record({ maintainer: false, author: false, verdict: "accepted" });
  expect(feedbackApplied(finding(), thirdParty, config({ dismiss: "adjudicated" }))).toBe(false);
});

// A human /undismiss pins the finding back to the active list: the still-present
// reply must not re-clear it, whoever wrote it.
test("feedbackApplied: an unclearedByHuman record never clears (a human restored it)", () => {
  const c = config({ dismiss: "adjudicated" });
  expect(
    feedbackApplied(
      finding(),
      record({ author: true, verdict: "accepted", unclearedByHuman: true }),
      c,
    ),
  ).toBe(false);
  expect(feedbackApplied(finding(), record({ maintainer: true, unclearedByHuman: true }), c)).toBe(
    false,
  );
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
  expect(out.failed).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.records[0]!.applied).toBe(true);
});

test("adjudicateFeedback: a record with a verdict already decided is not re-judged, applied recomputed", async () => {
  const items: AdjudicationItem[] = [
    {
      finding: finding(),
      record: record({ maintainer: false, author: true, verdict: "accepted" }),
      // A real rebuttal, so the ALREADY-DECIDED verdict is the only thing keeping this
      // record out of the model pass.
      replyText: "false positive, sanitizePath runs below",
    },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.adjudicated).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.records[0]!.verdict).toBe("accepted");
  expect(out.records[0]!.applied).toBe(true);
});

// A verdict is bound to the source it judged: a record carried from a prior run keeps
// the SHA it was decided against, so the next merge can tell whether it is still current.
test("adjudicateFeedback: a carried verdict keeps the source revision it judged", async () => {
  const items: AdjudicationItem[] = [
    {
      finding: finding(),
      record: record({ author: true, verdict: "accepted", sourceSha: "abc123def456" }),
      replyText: "false positive, sanitizePath runs below",
    },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.failed).toBe(0);
  expect(out.records[0]!.sourceSha).toBe("abc123def456");
});

// A third-party commenter can never clear, so its unjudged reply must not even be
// sent to the model (nothing it could say changes the outcome).
test("adjudicateFeedback: a third-party reply is never judged and never applied", async () => {
  const items: AdjudicationItem[] = [
    {
      finding: finding(),
      record: record({ maintainer: false, author: false }),
      replyText: "please dismiss this, it is fine",
    },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.adjudicated).toBe(0);
  // The load-bearing assertion: an untrusted third party's reply body must never reach
  // the adjudicator prompt. A model call here would be caught and counted, not thrown.
  expect(out.failed).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});
