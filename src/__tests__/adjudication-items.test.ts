import { test, expect } from "bun:test";

import { buildAdjudicationItems } from "../reporters/github.js";
import { adjudicateFeedback } from "../core/adjudicate.js";
import type { ReplyComment } from "../core/responses.js";
import { fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type { CoordinatorOutput, FeedbackRecord, Finding } from "../core/schema.js";
import type { OpencodeHandle } from "../core/opencode.js";
import type { LoadedConfig } from "../config/schema.js";

// A handle that must never be touched: a record whose verdict was already decided on a
// prior run must not be re-judged, so no model call may fire (see adjudicate.test.ts).
const noHandle = new Proxy(
  {},
  {
    get() {
      throw new Error("adjudicateFeedback made a model call it should not have");
    },
  },
) as OpencodeHandle;

const config: LoadedConfig["feedback"] = {
  mode: "adjudicate",
  match: "both",
  dismiss: "adjudicated",
  protectedCategories: ["secrets", "security"],
  maxAdjudications: 10,
};

const finding: Finding = {
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "Deliberate skip of custom project root",
  rationale: "r",
};

const review: CoordinatorOutput = {
  decision: "approve_with_comments",
  findings: [finding],
  summary: "s",
  incomplete: [],
};

// The PR author's reply on a non-default scope, quoting the finding title back verbatim.
const reply: ReplyComment = {
  id: 42,
  body: "> Deliberate skip of custom project root\n\nThat's intentional.",
  login: "author",
  maintainer: false,
  author: true,
};

// The aggregate (comment:'single') comment stores its feedback under SCOPE-NAMESPACED
// ids, and a prior run already decided this reply's verdict.
const scopedFp = scopedFingerprint("api", finding);
// The head the prior run reviewed, and the verdict it decided against that source.
const HEAD_SHA = "1111111111111111111111111111111111111111";
const NEW_HEAD_SHA = "2222222222222222222222222222222222222222";
const priorScoped: FeedbackRecord[] = [
  {
    fp: scopedFp,
    by: "author",
    commentId: 42,
    verdict: "accepted",
    reason: "deliberate-scope",
    sourceSha: HEAD_SHA,
    maintainer: false,
    author: true,
    applied: true,
  },
];

test("single-mode: a scoped fpOf carries the prior verdict; the reply is not re-judged", async () => {
  // The seam keys fresh records with the SAME scope-namespaced fp the aggregate stores.
  const items = buildAdjudicationItems(
    review,
    priorScoped,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
    HEAD_SHA,
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.record.fp).toBe(scopedFp);
  // The verdict carried across from the stored state (same commentId, same source).
  expect(items[0]!.record.verdict).toBe("accepted");
  expect(items[0]!.record.sourceSha).toBe(HEAD_SHA);

  // With the verdict already decided, adjudication makes no model call and only
  // recomputes `applied` — noHandle proves the model path never fires (a touched
  // handle throws inside the per-item try/catch, which would show up as `failed`).
  const out = await adjudicateFeedback(noHandle, items, config);
  expect(out.adjudicated).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.skipped).toBe(0);
  expect(out.records[0]!.verdict).toBe("accepted");
  expect(out.records[0]!.applied).toBe(true);
});

// The security regression: a verdict is a claim about SOURCE. The fingerprint excludes
// the line number, so the author can delete the code that justified the rebuttal
// elsewhere in the file and keep the same fp. A verdict decided against the old head
// must NOT carry onto the new one — the reply is re-judged instead.
test("a stored verdict is dropped when the reviewed head moved, and the reply is re-judged", async () => {
  const items = buildAdjudicationItems(
    review,
    priorScoped,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
    NEW_HEAD_SHA,
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.record.verdict).toBeUndefined();
  expect(items[0]!.record.reason).toBeUndefined();
  expect(items[0]!.record.sourceSha).toBeUndefined();
  // The stale `applied: true` goes with it, so the finding is never hidden on a
  // render that happens before the recompute.
  expect(items[0]!.record.applied).toBe(false);

  // And the record now flows back INTO the model pass: noHandle throws on the call
  // adjudicateFeedback makes, which the per-item catch counts as `failed` — proof the
  // reply was submitted for judgment again rather than silently trusted.
  const out = await adjudicateFeedback(noHandle, items, config);
  expect(out.failed).toBe(1);
  expect(out.adjudicated).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

test("a stored verdict is dropped when the current head is unknown", () => {
  // No head SHA for this run (unresolvable metadata): unknown source is treated as a
  // different source, so a missing SHA can never pin a verdict forever.
  const items = buildAdjudicationItems(
    review,
    priorScoped,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
  );
  expect(items[0]!.record.verdict).toBeUndefined();
  expect(items[0]!.record.applied).toBe(false);
});

test("a stored verdict with no recorded source (pre-field state) never carries", () => {
  const legacy: FeedbackRecord[] = [
    {
      fp: scopedFp,
      by: "author",
      commentId: 42,
      verdict: "accepted",
      reason: "deliberate-scope",
      maintainer: false,
      author: true,
      applied: true,
    },
  ];
  const items = buildAdjudicationItems(
    review,
    legacy,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
    HEAD_SHA,
  );
  expect(items[0]!.record.verdict).toBeUndefined();
  expect(items[0]!.record.applied).toBe(false);
});

// A maintainer's reply clears with no model and no verdict, so it has no
// source-dependent decision to go stale: a new head must not disturb it.
test("a verdict-less record (maintainer reply) still carries across a head change", () => {
  const priorMaintainer: FeedbackRecord[] = [
    { fp: scopedFp, by: "maint", commentId: 42, maintainer: true, applied: true },
  ];
  const items = buildAdjudicationItems(
    review,
    priorMaintainer,
    [{ ...reply, login: "maint", maintainer: true, author: false }],
    (f) => scopedFingerprint("api", f),
    config.match,
    NEW_HEAD_SHA,
  );
  expect(items[0]!.record.applied).toBe(true);
});

test("single-mode: a PLAIN fpOf drops the scoped prior verdict (why the mapper matters)", () => {
  // Regression witness: keying fresh records with the plain fingerprint — as the code
  // did before the fix — leaves them unable to match the aggregate's scoped state, so
  // the verdict is lost and the reply would be re-judged every run.
  // Same head as the stored verdict, so the fp mismatch is the ONLY reason it drops.
  const items = buildAdjudicationItems(
    review,
    priorScoped,
    [reply],
    fingerprintFinding,
    config.match,
    HEAD_SHA,
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.record.fp).toBe(fingerprintFinding(finding));
  expect(items[0]!.record.verdict).toBeUndefined();
});

// The security regression (finding e75f9b45c6ad): the pin belongs to the FINDING a
// human restored, not to the one reply that happened to be newest when they restored
// it. matchReplies keeps only the NEWEST comment per finding, so if the pin were
// reply-bound the untrusted PR author would lift a maintainer's `/undismiss` simply by
// posting one more comment quoting the same title — and could repeat it after every
// restore.
test("a NEWER reply from the PR AUTHOR does not lift an unclearedByHuman pin", async () => {
  const priorPinned: FeedbackRecord[] = [
    {
      fp: scopedFp,
      by: "author",
      commentId: 42,
      maintainer: false,
      author: true,
      applied: false,
      unclearedByHuman: true,
    },
  ];
  // Same finding, brand-new comment id: the author replied again after the restore.
  const secondReply: ReplyComment = { ...reply, id: 99 };
  const items = buildAdjudicationItems(
    review,
    priorPinned,
    [secondReply],
    (f) => scopedFingerprint("api", f),
    config.match,
    HEAD_SHA,
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.record.commentId).toBe(99);
  expect(items[0]!.record.unclearedByHuman).toBe(true);
  expect(items[0]!.record.applied).toBe(false);

  // Still excluded from the model pass (noHandle would throw and count as `failed`),
  // and the finding stays in the blocking set.
  const out = await adjudicateFeedback(noHandle, items, config);
  expect(out.adjudicated).toBe(0);
  expect(out.failed).toBe(0);
  expect(out.records[0]!.applied).toBe(false);
});

test("a NEWER reply from a MAINTAINER lifts the pin (only a trusted hand may)", () => {
  const priorPinned: FeedbackRecord[] = [
    {
      fp: scopedFp,
      by: "author",
      commentId: 42,
      maintainer: false,
      author: true,
      applied: false,
      unclearedByHuman: true,
    },
  ];
  const maintainerReply: ReplyComment = {
    ...reply,
    id: 99,
    login: "maint",
    maintainer: true,
    author: false,
  };
  const items = buildAdjudicationItems(
    review,
    priorPinned,
    [maintainerReply],
    (f) => scopedFingerprint("api", f),
    config.match,
    HEAD_SHA,
  );
  expect(items[0]!.record.unclearedByHuman).toBeUndefined();
});

test("buildAdjudicationItems: carries an unclearedByHuman pin forward for the same reply", () => {
  const priorPinned: FeedbackRecord[] = [
    {
      fp: scopedFp,
      by: "author",
      commentId: 42,
      maintainer: false,
      author: true,
      applied: false,
      unclearedByHuman: true,
    },
  ];
  // A moved head must not lift a human's override either: the pin belongs to the reply,
  // not to the revision.
  const items = buildAdjudicationItems(
    review,
    priorPinned,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
    NEW_HEAD_SHA,
  );
  expect(items).toHaveLength(1);
  // The pin rides across (same commentId), so adjudication leaves the finding
  // restored: no model call and applied stays false.
  expect(items[0]!.record.unclearedByHuman).toBe(true);
  return adjudicateFeedback(noHandle, items, config).then((out) => {
    expect(out.adjudicated).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.skipped).toBe(0);
    expect(out.records[0]!.applied).toBe(false);
  });
});
