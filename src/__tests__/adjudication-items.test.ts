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
const priorScoped: FeedbackRecord[] = [
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

test("single-mode: a scoped fpOf carries the prior verdict; the reply is not re-judged", async () => {
  // The seam keys fresh records with the SAME scope-namespaced fp the aggregate stores.
  const items = buildAdjudicationItems(
    review,
    priorScoped,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.record.fp).toBe(scopedFp);
  // The verdict carried across from the stored state (same commentId).
  expect(items[0]!.record.verdict).toBe("accepted");

  // With the verdict already decided, adjudication makes no model call and only
  // recomputes `applied` — noHandle proves the model path never fires.
  const out = await adjudicateFeedback(noHandle, items, config);
  expect(out.adjudicated).toBe(0);
  expect(out.records[0]!.verdict).toBe("accepted");
  expect(out.records[0]!.applied).toBe(true);
});

test("single-mode: a PLAIN fpOf drops the scoped prior verdict (why the mapper matters)", () => {
  // Regression witness: keying fresh records with the plain fingerprint — as the code
  // did before the fix — leaves them unable to match the aggregate's scoped state, so
  // the verdict is lost and the reply would be re-judged every run.
  const items = buildAdjudicationItems(
    review,
    priorScoped,
    [reply],
    fingerprintFinding,
    config.match,
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.record.fp).toBe(fingerprintFinding(finding));
  expect(items[0]!.record.verdict).toBeUndefined();
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
  const items = buildAdjudicationItems(
    review,
    priorPinned,
    [reply],
    (f) => scopedFingerprint("api", f),
    config.match,
  );
  expect(items).toHaveLength(1);
  // The pin rides across (same commentId), so adjudication leaves the finding
  // restored: no model call and applied stays false.
  expect(items[0]!.record.unclearedByHuman).toBe(true);
  return adjudicateFeedback(noHandle, items, config).then((out) => {
    expect(out.adjudicated).toBe(0);
    expect(out.records[0]!.applied).toBe(false);
  });
});
