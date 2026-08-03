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

// `citedId` is left OFF by default — a plain quote-match, which is what most replies
// are — so every test that expects a clear has to say `citedId: true` out loud.
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
  expect(feedbackApplied(finding(), record({ maintainer: true, citedId: true }), c)).toBe(false);
  expect(feedbackApplied(finding(), record({ verdict: "accepted", citedId: true }), c)).toBe(false);
});

test("feedbackApplied: mode:'off' never applies, whatever dismiss says", () => {
  const c = config({ mode: "off", dismiss: "adjudicated" });
  expect(feedbackApplied(finding(), record({ maintainer: true, citedId: true }), c)).toBe(false);
});

// `mode` gates the machinery, `dismiss` gates the clearing: a maintainer reply
// needs no model, so it must clear under plain annotate mode — same trust gate
// as /dismiss.
test("feedbackApplied: mode:'annotate' + dismiss:'maintainers' clears on a maintainer reply", () => {
  const c = config({ mode: "annotate", dismiss: "maintainers" });
  expect(feedbackApplied(finding(), record({ maintainer: true, citedId: true }), c)).toBe(true);
  expect(feedbackApplied(finding(), record({ verdict: "accepted", citedId: true }), c)).toBe(false);
});

test("feedbackApplied: a critical finding is never applied, even maintainer + accepted", () => {
  const c = config({ dismiss: "adjudicated" });
  const crit = finding({ severity: "critical" });
  expect(feedbackApplied(crit, record({ maintainer: true, citedId: true }), c)).toBe(false);
  expect(feedbackApplied(crit, record({ verdict: "accepted", citedId: true }), c)).toBe(false);
});

// The floor is pinned to a LITERAL, then the literal is what the assertions loop over.
// Looping over HARD_FLOOR_CATEGORIES itself would assert only "whatever the constant
// says today": shrinking it to ["secrets"] would still pass, and emptying it would run
// zero assertions — while README and LLP 0011 both promise both categories are floored.
test("HARD_FLOOR_CATEGORIES is exactly secrets + security", () => {
  expect([...HARD_FLOOR_CATEGORIES]).toEqual(["secrets", "security"]);
});

test("feedbackApplied: secrets/security are floored in code regardless of protectedCategories", () => {
  // Even with the protected set narrowed to empty, the code floor still holds.
  const c = config({ dismiss: "adjudicated", protectedCategories: [] });
  for (const category of ["secrets", "security"] as const) {
    const f = finding({ category });
    expect(feedbackApplied(f, record({ maintainer: true, citedId: true }), c)).toBe(false);
    expect(feedbackApplied(f, record({ verdict: "accepted", citedId: true }), c)).toBe(false);
  }
});

test("feedbackApplied: a configured protectedCategory can only widen the floor", () => {
  const c = config({ dismiss: "adjudicated", protectedCategories: ["quality"] });
  expect(
    feedbackApplied(
      finding({ category: "quality" }),
      record({ maintainer: true, citedId: true }),
      c,
    ),
  ).toBe(false);
});

test("feedbackApplied: a maintainer reply clears a non-floored finding, no verdict needed", () => {
  expect(feedbackApplied(finding(), record({ maintainer: true, citedId: true }), config())).toBe(
    true,
  );
});

// Finding 1fbf85c0e651: a quoted line is not consent. GitHub's "Quote reply" copies the
// whole target comment with every line prefixed `> `, so the untrusted PR author can
// write a finding's title (or its id) in a comment and have a maintainer's one-click
// quote-reply carry it — matching the finding on text the maintainer never wrote. A
// quote-matched reply may therefore ANNOTATE, but only a reply citing the finding's id
// in the replier's own words may CLEAR.
test("feedbackApplied: a quote-only reply never clears, on either clear path", () => {
  const c = config({ dismiss: "adjudicated" });
  // The attack: the maintainer quote-replied to the author's planted text.
  expect(feedbackApplied(finding(), record({ maintainer: true, by: "maint" }), c)).toBe(false);
  // The same rule on the adjudicated author path, even with an accepted verdict.
  expect(feedbackApplied(finding(), record({ author: true, verdict: "accepted" }), c)).toBe(false);
  // Control: the identical records with the id cited do clear.
  expect(feedbackApplied(finding(), record({ maintainer: true, citedId: true }), c)).toBe(true);
  expect(
    feedbackApplied(finding(), record({ author: true, verdict: "accepted", citedId: true }), c),
  ).toBe(true);
});

test("feedbackApplied: the PR author clears only under 'adjudicated' + an accepted verdict", () => {
  const author = record({ maintainer: false, author: true, verdict: "accepted", citedId: true });
  expect(feedbackApplied(finding(), author, config({ dismiss: "adjudicated" }))).toBe(true);
  // A maintainers-only policy ignores the adjudicated verdict of a non-maintainer.
  expect(feedbackApplied(finding(), author, config({ dismiss: "maintainers" }))).toBe(false);
  // Accepted is required — a refuted or unset verdict does not clear.
  expect(
    feedbackApplied(
      finding(),
      record({ author: true, verdict: "refuted", citedId: true }),
      config({ dismiss: "adjudicated" }),
    ),
  ).toBe(false);
});

// The security floor: only the PR author (or a maintainer) may clear via a reply.
// A random third-party commenter's rebuttal — even one a model accepts — never clears.
test("feedbackApplied: a third-party commenter never clears, even with an accepted verdict", () => {
  const thirdParty = record({
    maintainer: false,
    author: false,
    verdict: "accepted",
    citedId: true,
  });
  expect(feedbackApplied(finding(), thirdParty, config({ dismiss: "adjudicated" }))).toBe(false);
});

// A human /undismiss pins the finding back to the active list: the still-present
// reply must not re-clear it, whoever wrote it.
test("feedbackApplied: an unclearedByHuman record never clears (a human restored it)", () => {
  const c = config({ dismiss: "adjudicated" });
  expect(
    feedbackApplied(
      finding(),
      record({ author: true, verdict: "accepted", citedId: true, unclearedByHuman: true }),
      c,
    ),
  ).toBe(false);
  expect(
    feedbackApplied(
      finding(),
      record({ maintainer: true, citedId: true, unclearedByHuman: true }),
      c,
    ),
  ).toBe(false);
});

// ---- adjudicateFeedback: recompute without model calls ----

// A record every toJudge gate lets through (the PR author, cites the id, no prior
// verdict, no `/undismiss` pin) paired with real reply text. Each test below then varies
// exactly ONE thing, so the gate it names is the only reason nothing is judged — a
// fixture excluded by a second gate would stay green with the named gate deleted.
const eligibleRecord = (over: Partial<FeedbackRecord> = {}): FeedbackRecord =>
  record({ author: true, citedId: true, ...over });
const REBUTTAL = "false positive, sanitizePath runs below";

test("adjudicateFeedback: mode:'off' makes no model calls and applies nothing", async () => {
  const items: AdjudicationItem[] = [
    { finding: finding(), record: eligibleRecord(), replyText: REBUTTAL },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ mode: "off" }));
  expect(out.adjudicated).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

// `mode: "annotate"` + an opted-in `dismiss` wires the seam with no model in it
// (feedbackNeedsRunSeam): the same judge-eligible reply must still never be judged.
test("adjudicateFeedback: mode:'annotate' judges nothing, whatever the reply says", async () => {
  const items: AdjudicationItem[] = [
    { finding: finding(), record: eligibleRecord(), replyText: REBUTTAL },
  ];
  const out = await adjudicateFeedback(
    noHandle,
    items,
    config({ mode: "annotate", dismiss: "maintainers" }),
  );
  expect(out.adjudicated).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

// Nothing to check against the source, so there is nothing to judge. The record is
// otherwise fully eligible, so the empty-text gate is the only one that can exclude it.
test("adjudicateFeedback: a reply with no text is never judged", async () => {
  const items: AdjudicationItem[] = [
    { finding: finding(), record: eligibleRecord(), replyText: "   \n" },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.adjudicated).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

test("adjudicateFeedback: a maintainer reply is applied with no model call (empty replyText)", async () => {
  const items: AdjudicationItem[] = [
    { finding: finding(), record: record({ maintainer: true, citedId: true }), replyText: "" },
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
      record: record({ maintainer: false, author: true, verdict: "accepted", citedId: true }),
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
// A quote-only reply cannot clear whatever the verdict says, so judging it would spend
// the run's cap on a rebuttal that can move no outcome — and could starve a reply that
// does cite the finding.
test("adjudicateFeedback: a quote-only author reply is never judged and never applied", async () => {
  const items: AdjudicationItem[] = [
    {
      finding: finding(),
      record: record({ author: true }),
      replyText: "false positive, sanitizePath runs below",
    },
  ];
  const out = await adjudicateFeedback(noHandle, items, config({ dismiss: "adjudicated" }));
  expect(out.adjudicated).toBe(0);
  // A model call would be caught by the per-item try/catch and counted here.
  expect(out.failed).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

test("adjudicateFeedback: a third-party reply is never judged and never applied", async () => {
  const items: AdjudicationItem[] = [
    {
      finding: finding(),
      // Cites the finding's id, so the citedId gate lets it through and the author gate
      // is the only thing left that can keep this reply out of the adjudicator prompt.
      record: record({ maintainer: false, author: false, citedId: true }),
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

// Finding floored-adjudication: `feedbackApplied` floors critical + secrets/security in
// code, so NO verdict can ever clear them. Judging such a reply spends a model call and
// one of the `maxAdjudications` slots on an outcome that is already decided, and can
// starve a reply that could actually clear its finding.
// `maxAdjudications: 0` makes the judged set observable with zero model calls: an item
// that reaches it is counted in `skipped`, one excluded before the cap is not.
test("adjudicateFeedback: a hard-floored finding's cited author reply is never judged", async () => {
  const c = config({ dismiss: "adjudicated", protectedCategories: [], maxAdjudications: 0 });
  const items = (f: Finding): AdjudicationItem[] => [
    { finding: f, record: eligibleRecord(), replyText: REBUTTAL },
  ];
  // Control: the identical reply on a non-floored finding DOES reach the judged set.
  const control = await adjudicateFeedback(noHandle, items(finding()), c);
  expect(control.skipped).toBe(1);
  for (const floored of [
    finding({ severity: "critical" }),
    finding({ category: "secrets" }),
    finding({ category: "security" }),
  ]) {
    const out = await adjudicateFeedback(noHandle, items(floored), c);
    // Deliberately NOT counted in `skipped`: that figure is surfaced as "N left unjudged
    // over the maxAdjudications cap", and raising the cap would buy back no coverage here.
    expect(out.skipped).toBe(0);
    expect(out.adjudicated).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.records[0]!.applied).toBe(false);
  }
});

// A config-tunable exclusion is NOT hard-floored: `protectedCategories` and `dismiss` can
// change, and `applied` is recomputed under the current config on every run, so a stored
// verdict on such a finding becomes useful the moment the repo widens its policy.
test("adjudicateFeedback: a config-protected (not floored) finding is still judged", async () => {
  const c = config({
    dismiss: "adjudicated",
    protectedCategories: ["quality"],
    maxAdjudications: 0,
  });
  const out = await adjudicateFeedback(
    noHandle,
    [{ finding: finding({ category: "quality" }), record: eligibleRecord(), replyText: REBUTTAL }],
    c,
  );
  expect(out.skipped).toBe(1);
  expect(out.records[0]!.applied).toBe(false);
});
