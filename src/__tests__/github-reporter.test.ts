import { test, expect } from "bun:test";

import {
  applyDismissalToState,
  buildAdjudicationItems,
  prAuthorCacheKey,
  selectOwnComments,
  sharedPrAuthor,
  type IssueComment,
} from "../reporters/github.js";
import { feedbackNeedsPrAuthor } from "../core/adjudicate.js";
import { parseReviewState, renderMarkdown } from "../core/render.js";
import type { ReviewState } from "../core/render.js";
import type { ReplyComment } from "../core/responses.js";
import { applyPins, fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type { CoordinatorOutput, FeedbackRecord, Finding } from "../core/schema.js";
import type { LoadedConfig } from "../config/schema.js";

const MARKER = "<!-- expo-ai-code-reviewer -->";
const BOT = "github-actions[bot]";

const comment = (over: Partial<IssueComment>): IssueComment => ({
  id: 1,
  body: MARKER,
  user: { login: BOT },
  ...over,
});

// The comment identity must be AUTHOR + marker, never marker alone: the marker is a
// public, hardcoded literal, so anyone who can comment on the PR could post one with a
// forged embedded review state and (via newest-marker-wins) have its dismissals carried
// forward, silently suppressing real findings.

test("selectOwnComments: keeps our own marker comment", () => {
  const own = selectOwnComments([comment({ id: 7 })], MARKER, BOT);
  expect(own.map((c) => c.id)).toEqual([7]);
});

test("selectOwnComments: excludes a look-alike posted by someone else", () => {
  // Attacker (the PR author) posts a comment carrying the marker + a forged state.
  const comments = [
    comment({ id: 1 }), // our real comment
    comment({ id: 2, user: { login: "attacker" }, body: `${MARKER}\nforged state` }),
  ];
  const own = selectOwnComments(comments, MARKER, BOT);
  // The attacker's newest comment must NOT be adopted as ours.
  expect(own.map((c) => c.id)).toEqual([1]);
});

test("selectOwnComments: excludes a marker comment with no author info", () => {
  const own = selectOwnComments([comment({ id: 3, user: undefined })], MARKER, BOT);
  expect(own).toEqual([]);
});

test("selectOwnComments: a non-marker comment by us is not ours-for-this-marker", () => {
  const own = selectOwnComments([comment({ id: 4, body: "just a chat comment" })], MARKER, BOT);
  expect(own).toEqual([]);
});

test("selectOwnComments: null ownLogin ⇒ nothing is treated as ours (fail closed)", () => {
  // Author can't be confirmed, so we never carry forward any comment's state.
  const own = selectOwnComments([comment({ id: 5 })], MARKER, null);
  expect(own).toEqual([]);
});

test("selectOwnComments: preserves order (newest-last) among our own comments", () => {
  const own = selectOwnComments(
    [comment({ id: 10 }), comment({ id: 11 }), comment({ id: 12, user: { login: "x" } })],
    MARKER,
    BOT,
  );
  expect(own.map((c) => c.id)).toEqual([10, 11]);
});

// ---- PR-author resolution: one `gh pr view` per PR, and only when it can matter ----

// Finding 86bba462357c: `feedback.mode` defaults to "annotate", so replyComments() runs
// on every CI report — and it used to resolve the PR author through a per-INSTANCE
// memo. Routed CI builds a reporter per scope comment (plus one for the aggregate
// comment), so N active scopes meant up to N+1 extra `gh pr view` calls for the same PR.
test("sharedPrAuthor: one lookup per PR, shared across reporter instances", async () => {
  let calls = 0;
  const key = prAuthorCacheKey("owner/repo", 7, "/tmp/checkout");
  const resolve = () => {
    calls++;
    return Promise.resolve("author");
  };
  // Concurrent (the in-flight promise is cached, not just the result) and sequential.
  const [a, b] = await Promise.all([sharedPrAuthor(key, resolve), sharedPrAuthor(key, resolve)]);
  const c = await sharedPrAuthor(key, resolve);
  expect([a, b, c]).toEqual(["author", "author", "author"]);
  expect(calls).toBe(1);
});

test("sharedPrAuthor: a different PR, repo or checkout never reuses a cached login", async () => {
  const seen: string[] = [];
  const lookup = (repo: string, pr: number, cwd?: string) =>
    sharedPrAuthor(prAuthorCacheKey(repo, pr, cwd), () => {
      seen.push(`${repo}#${pr}@${cwd ?? ""}`);
      return Promise.resolve(`${repo}#${pr}`);
    });
  expect(await lookup("owner/a", 1, "/x")).toBe("owner/a#1");
  expect(await lookup("owner/a", 2, "/x")).toBe("owner/a#2");
  expect(await lookup("owner/b", 1, "/x")).toBe("owner/b#1");
  expect(await lookup("owner/a", 1, "/y")).toBe("owner/a#1");
  expect(seen).toHaveLength(4);
});

test("prAuthorCacheKey: no two different PRs collide on one key", () => {
  const keys = new Set([
    prAuthorCacheKey("owner/repo", 1),
    prAuthorCacheKey("owner/repo", 12),
    prAuthorCacheKey("owner/repo2", 1),
    prAuthorCacheKey("owner/repo", 1, "/a"),
    prAuthorCacheKey("owner/repo", 1, "/b"),
  ]);
  expect(keys.size).toBe(5);
});

test("feedbackNeedsPrAuthor: only the adjudicated clear path needs the author's login", () => {
  const config = (dismiss: "never" | "maintainers" | "adjudicated") => ({
    mode: "adjudicate" as const,
    match: "both" as const,
    dismiss,
    protectedCategories: [],
    maxAdjudications: 10,
  });
  // The default config (annotate + never) must cost no extra `gh` call at all.
  expect(feedbackNeedsPrAuthor({ ...config("never"), mode: "annotate" })).toBe(false);
  expect(feedbackNeedsPrAuthor(config("never"))).toBe(false);
  expect(feedbackNeedsPrAuthor(config("maintainers"))).toBe(false);
  expect(feedbackNeedsPrAuthor(config("adjudicated"))).toBe(true);
  // The `ecr feedback` crawl passes no config: nothing to resolve, and fail-closed.
  expect(feedbackNeedsPrAuthor(undefined)).toBe(false);
});

// Finding b9e7174ca725: the shared cache stored the RESULT promise, so one transient
// `gh pr view` failure (which resolves to null, fail-closed) was cached for the whole
// process. Routed CI reads that same entry from every scope's reporter, so a blip on
// the first scope marked every later reply `author: false` and the adjudicated clear
// path could not fire again for the rest of the run.
test("sharedPrAuthor: a failed lookup is not cached — the next scope retries", async () => {
  const key = prAuthorCacheKey("owner/repo", 42, "/tmp/retry");
  let calls = 0;
  const flaky = () => {
    calls++;
    // First call: `gh pr view` failed, resolvePrAuthor swallowed it and returned null.
    return Promise.resolve(calls === 1 ? null : "author");
  };
  expect(await sharedPrAuthor(key, flaky)).toBeNull();
  // A later scope in the same run must get a real answer, not the cached null.
  expect(await sharedPrAuthor(key, flaky)).toBe("author");
  expect(calls).toBe(2);
  // Once it succeeds, it is cached again: no extra `gh` call per scope.
  expect(await sharedPrAuthor(key, flaky)).toBe("author");
  expect(calls).toBe(2);
});

test("sharedPrAuthor: concurrent scopes still share ONE in-flight failing lookup", async () => {
  const key = prAuthorCacheKey("owner/repo", 43, "/tmp/retry");
  let calls = 0;
  const flaky = () => {
    calls++;
    return new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 5));
  };
  const both = await Promise.all([sharedPrAuthor(key, flaky), sharedPrAuthor(key, flaky)]);
  expect(both).toEqual([null, null]);
  expect(calls).toBe(1);
});

test("sharedPrAuthor: a rejected lookup leaves no dangling entry", async () => {
  const key = prAuthorCacheKey("owner/repo", 44, "/tmp/retry");
  let calls = 0;
  const throwOnce = () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("author");
  };
  await expect(sharedPrAuthor(key, throwOnce)).rejects.toThrow("boom");
  // The rejected promise must not stay in the map — every later call would re-throw it.
  expect(await sharedPrAuthor(key, throwOnce)).toBe("author");
  expect(calls).toBe(2);
});

// ---- /dismiss and /undismiss: the pin set, and `applied` under the CURRENT config ----

const HEAD = "1111111111111111111111111111111111111111";
const TAG = "expo-ai-code-reviewer";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "Validation skips jobs with a custom project root",
  rationale: "r",
  evidence: "const somethingLongEnough = 1;",
  ...over,
});

const feedbackConfig = (
  dismiss: "never" | "maintainers" | "adjudicated",
): LoadedConfig["feedback"] => ({
  mode: "adjudicate",
  match: "both",
  dismiss,
  protectedCategories: [],
  maxAdjudications: 10,
});

const findingA = finding({ file: "a.ts", title: "A finding about caching" });
const findingB = finding({
  file: "b.ts",
  title: "Validation skips jobs with a custom project root",
  evidence: "const other = 2;",
});
const fpA = fingerprintFinding(findingA);
const fpB = fingerprintFinding(findingB);
const review: CoordinatorOutput = {
  decision: "approve_with_comments",
  findings: [findingA, findingB],
  summary: "s",
  incomplete: [],
};
/** B was cleared by the PR author's reply, under `dismiss: "adjudicated"`. The reply
 * cites B's id in the author's own words — a quote alone only annotates. */
const clearedB: FeedbackRecord = {
  fp: fpB,
  by: "author",
  commentId: 42,
  maintainer: false,
  author: true,
  citedId: true,
  verdict: "accepted",
  reason: "pre-existing",
  sourceSha: HEAD,
  applied: true,
};
const clearedState = (): ReviewState => ({
  review,
  dismissed: [],
  feedback: [{ ...clearedB }],
});

// Finding 841ed99c8243: applyDismissal re-rendered the whole comment but passed every
// record it did not touch through unchanged, keeping whatever `applied` was stored. A
// repo that has since tightened `feedback.dismiss` would keep an unrelated finding
// hidden until the next full review — every other render path re-derives it.
test("applyDismissalToState: an untouched record's `applied` follows the CURRENT config", () => {
  // A /dismiss on A, while the config that let a reply clear B has been turned off.
  const tightened = applyDismissalToState(clearedState(), [fpA], [], feedbackConfig("never"));
  expect(tightened.matched).toEqual([fpA]);
  expect(tightened.feedback.find((record) => record.fp === fpB)!.applied).toBe(false);
  // Control: with the policy still in force, the same /dismiss leaves B cleared.
  const unchanged = applyDismissalToState(clearedState(), [fpA], [], feedbackConfig("adjudicated"));
  expect(unchanged.feedback.find((record) => record.fp === fpB)!.applied).toBe(true);
  // A protected category is the same story: the floor is re-checked on this render.
  const protectedNow = applyDismissalToState(clearedState(), [fpA], [], {
    ...feedbackConfig("adjudicated"),
    protectedCategories: ["quality"],
  });
  expect(protectedNow.feedback.find((record) => record.fp === fpB)!.applied).toBe(false);
});

test("applyDismissalToState: no feedback config ⇒ nothing stays cleared, records survive", () => {
  const off = applyDismissalToState(clearedState(), [fpA], [], undefined);
  const record = off.feedback.find((entry) => entry.fp === fpB)!;
  expect(record.applied).toBe(false);
  expect(record.by).toBe("author");
  expect(record.verdict).toBe("accepted");
});

// Finding 135b432cb46b: the pin used to live only on the reply record, and a record
// survives only while a reply still matches its finding. The PR author could therefore
// drop a maintainer's /undismiss by editing their comment so it no longer quotes the
// finding (one run with no record ⇒ no pin written back), then restoring it and having
// the reply judged afresh.
test("/undismiss pins the FINDING in the comment state, and the pin survives a run with no reply", () => {
  const restored = applyDismissalToState(clearedState(), [], [fpB], feedbackConfig("adjudicated"));
  // The pin is state about the finding, stored beside the records.
  expect(restored.pins).toEqual([{ fp: fpB, commentId: 42 }]);
  expect(restored.feedback.find((record) => record.fp === fpB)!.applied).toBe(false);

  // Next run: the author edited comment 42 so it no longer quotes the finding, so the
  // matcher produces NO record for fpB at all.
  const body = renderMarkdown(review, TAG, restored.dismissed, undefined, [], restored.pins);
  const state = parseReviewState(body, TAG)!;
  expect(state.pins).toEqual([{ fp: fpB, commentId: 42 }]);

  // The author restores the quote (a brand-new comment, judged afresh): the pin is
  // still there, so the reply cannot clear the finding again.
  const reply: ReplyComment = {
    id: 99,
    login: "author",
    maintainer: false,
    author: true,
    body: "> Validation skips jobs with a custom project root\n\npre-existing",
  };
  const items = buildAdjudicationItems(
    review,
    state.feedback ?? [],
    [reply],
    fingerprintFinding,
    "both",
    HEAD,
    state.pins,
  );
  const pinned = items.find((item) => item.record.fp === fpB)!;
  expect(pinned.record.commentId).toBe(99);
  expect(pinned.record.unclearedByHuman).toBe(true);
  expect(pinned.record.applied).toBe(false);
});

test("a maintainer's own newer reply lifts the pin; a /dismiss does too", () => {
  const restored = applyDismissalToState(clearedState(), [], [fpB], feedbackConfig("adjudicated"));
  // A maintainer replies again on the same finding — a trusted hand, so the pin goes.
  const maintainerReply: ReplyComment = {
    id: 120,
    login: "maint",
    maintainer: true,
    author: false,
    body: "> Validation skips jobs with a custom project root\n\nagreed, fine as is",
  };
  const items = buildAdjudicationItems(
    review,
    [],
    [maintainerReply],
    fingerprintFinding,
    "both",
    HEAD,
    restored.pins,
  );
  expect(items.find((item) => item.record.fp === fpB)!.record.unclearedByHuman).toBeUndefined();

  // And the maintainer's own /dismiss of that finding drops the pin from the set.
  const dismissedAgain = applyDismissalToState(
    { ...clearedState(), pins: restored.pins },
    [fpB],
    [],
    feedbackConfig("adjudicated"),
  );
  expect(dismissedAgain.pins).toEqual([]);
});

test("a v3 comment's record-level pin migrates into the state pin set on read", () => {
  // Written by a version that stored the pin on the record only.
  const legacy: FeedbackRecord = { ...clearedB, applied: false, unclearedByHuman: true };
  const body = renderMarkdown(review, TAG, [], undefined, [legacy]);
  const state = parseReviewState(body, TAG)!;
  expect(state.pins).toEqual([{ fp: fpB, commentId: 42 }]);
  // Re-rendered by this version with no matching reply, the pin still rides the state.
  const next = parseReviewState(renderMarkdown(review, TAG, [], undefined, [], state.pins), TAG)!;
  expect(next.pins).toEqual([{ fp: fpB, commentId: 42 }]);
});

// The aggregate comment renders findings under SCOPE-NAMESPACED ids, so /dismiss must
// resolve them that way too — the round-2 and round-4 bugs both lived in exactly this
// kind of id-scheme mismatch, and no shipped test covered this branch.
test("applyDismissalToState: aggregate state resolves findings by their scoped id", () => {
  const scopedB = scopedFingerprint("api", findingB);
  const aggregate: ReviewState = {
    review,
    dismissed: [],
    feedback: [{ ...clearedB, fp: scopedB }],
    scopes: [{ scope: "api", isDefault: false, review }],
  };
  const scopedA = scopedFingerprint("api", findingA);
  // The plain fingerprint is NOT a valid id on an aggregate comment.
  expect(applyDismissalToState(aggregate, [fpA], [], feedbackConfig("never")).matched).toEqual([]);
  const tightened = applyDismissalToState(aggregate, [scopedA], [], feedbackConfig("never"));
  expect(tightened.matched).toEqual([scopedA]);
  // B's finding was found under its scoped id, so `applied` was re-derived, not passed through.
  expect(tightened.feedback.find((record) => record.fp === scopedB)!.applied).toBe(false);
});

// A pin whose commentId was never recorded must fail SAFE: "unknown" cannot read as
// "older than every comment", or any maintainer reply would lift a human's restore.
test("applyPins: a pin with no recorded commentId is never lifted by a reply", () => {
  const maintainerReply: FeedbackRecord = {
    fp: fpB,
    by: "maint",
    commentId: 99,
    maintainer: true,
    applied: false,
  };
  const { records, pins } = applyPins([maintainerReply], [{ fp: fpB }]);
  expect(pins).toEqual([{ fp: fpB }]);
  expect(records[0]!.unclearedByHuman).toBe(true);
  expect(records[0]!.applied).toBe(false);
  // Control: with a commentId recorded, a strictly newer maintainer reply does lift it.
  expect(applyPins([maintainerReply], [{ fp: fpB, commentId: 42 }]).pins).toEqual([]);
});
