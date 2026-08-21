import { test, expect } from "bun:test";

import {
  activeFindings,
  hasUnquotedMarker,
  inlineBodiesEqual,
  planInlineSync,
} from "../reporters/github.js";
import type { ExistingInlineComment } from "../reporters/github.js";
import {
  inlineCommentMarker,
  inlineStubBody,
  oneLineRationale,
  parseInlineMarkerFp,
  renderInlineCommentBody,
  renderMarkdown,
} from "../core/render.js";
import type { LinkContext } from "../core/render.js";
import { hasUnquotedInlineMarker, matchReplies, replyIsNewer } from "../core/responses.js";
import type { ReplyComment } from "../core/responses.js";
import { applyPins, fingerprintFinding } from "../core/schema.js";
import type { CoordinatorOutput, FeedbackRecord, Finding } from "../core/schema.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 5,
  title: "Observer restarts for cached instances",
  rationale: "getInstances() restarts the push token observer for cached instances.",
  ...over,
});

const existing = (over: Partial<ExistingInlineComment> = {}): ExistingInlineComment => ({
  id: 1,
  fp: "aaaa11",
  body: "old",
  hasReplies: false,
  ...over,
});

const TAG = "expo-ai-code-reviewer";

// ---- marker format + anchored parse ----

test("inline marker roundtrips through the anchored parser", () => {
  const body = renderInlineCommentBody(finding(), TAG, "deadbeef11");
  expect(body.startsWith(inlineCommentMarker(TAG, "deadbeef11"))).toBe(true);
  expect(parseInlineMarkerFp(body, TAG)).toBe("deadbeef11");
  expect(parseInlineMarkerFp(inlineStubBody(TAG, "deadbeef11"), TAG)).toBe("deadbeef11");
});

test("parseInlineMarkerFp: a marker anywhere but byte 0 parses to nothing", () => {
  const forged = `prose first\n${inlineCommentMarker(TAG, "deadbeef11")}`;
  expect(parseInlineMarkerFp(forged, TAG)).toBeNull();
  // A quote-reply carrying the marker behind `> ` is not identity either.
  expect(parseInlineMarkerFp(`> ${inlineCommentMarker(TAG, "deadbeef11")}`, TAG)).toBeNull();
});

test("parseInlineMarkerFp: constrains the fp to the fingerprint alphabet and the exact tag", () => {
  expect(parseInlineMarkerFp(`<!-- ${TAG}:inline:fp=NOTHEX -->`, TAG)).toBeNull();
  expect(parseInlineMarkerFp(`<!-- other-tag:inline:fp=deadbeef11 -->`, TAG)).toBeNull();
  // A scoped tag never cross-parses under the root tag.
  expect(parseInlineMarkerFp(`<!-- ${TAG}:scope:inline:fp=deadbeef11 -->`, TAG)).toBeNull();
});

// ---- inline body ----

test("renderInlineCommentBody: id token, severity, rationale, suggestion, and no state markers", () => {
  const body = renderInlineCommentBody(
    finding({ suggestion: "cache it", rationale: "watch <!-- evil --> out" }),
    TAG,
    "deadbeef11",
  );
  expect(body).toContain("`id:deadbeef11`");
  expect(body).toContain("🟡 Warning");
  expect(body).toContain("**Suggestion:** cache it");
  // Untrusted text can never smuggle a raw HTML comment opener into our body.
  expect(body).toContain("&lt;!-- evil -->");
  expect(body).not.toMatch(/:(?:state|fingerprints)=/);
});

test("inlineStubBody: neutral — never claims resolved or dismissed", () => {
  const stub = inlineStubBody(TAG, "deadbeef11");
  expect(stub.toLowerCase()).not.toContain("resolved");
  expect(stub.toLowerCase()).not.toContain("dismissed");
  expect(stub).toContain("main review comment");
});

// ---- oneLineRationale ----

test("oneLineRationale: collapses whitespace, escapes <, truncates at a word boundary", () => {
  expect(oneLineRationale("a\n\nb   c")).toBe("a b c");
  expect(oneLineRationale("<details>x</details>")).toBe("&lt;details>x&lt;/details>");
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const short = oneLineRationale(long);
  expect(short.length).toBeLessThanOrEqual(161);
  expect(short.endsWith("…")).toBe(true);
  // Cut lands on a word boundary: the kept prefix is followed by a space in the input.
  const kept = short.slice(0, -1);
  expect(long.startsWith(kept)).toBe(true);
  expect(long[kept.length]).toBe(" ");
});

// ---- planner ----

test("planInlineSync: creates new, patches live, stubs replied stale, deletes bare stale", () => {
  const target = { fp: "aaaa11", finding: finding() };
  const plan = planInlineSync({
    targets: [target, { fp: "bbbb22", finding: finding({ file: "b.ts" }) }],
    existing: [
      existing({ id: 10, fp: "aaaa11" }),
      existing({ id: 11, fp: "gone01", hasReplies: true }),
      existing({ id: 12, fp: "gone02", hasReplies: false }),
    ],
    maxComments: 20,
    teardown: true,
  });
  expect(plan.patch.map((p) => p.comment.fp)).toEqual(["aaaa11"]);
  expect(plan.create.map((c) => c.fp)).toEqual(["bbbb22"]);
  expect(plan.stub.map((s) => s.fp)).toEqual(["gone01"]);
  expect(plan.remove.map((r) => r.fp)).toEqual(["gone02"]);
});

test("planInlineSync: teardown=false is additive-only, but still removes duplicates of a kept fp", () => {
  const plan = planInlineSync({
    targets: [{ fp: "aaaa11", finding: finding() }],
    existing: [
      existing({ id: 10, fp: "aaaa11" }),
      existing({ id: 9, fp: "aaaa11" }), // older duplicate (crash window)
      existing({ id: 11, fp: "gone01" }),
      existing({ id: 12, fp: "gone02", hasReplies: true }),
    ],
    maxComments: 20,
    teardown: false,
  });
  expect(plan.stub).toEqual([]);
  expect(plan.remove.map((r) => r.id)).toEqual([9]); // duplicate only, never live stale threads
  expect(plan.patch.map((p) => p.comment.id)).toEqual([10]); // newest duplicate is the live one
});

test("planInlineSync: the cap is sticky — a live thread is never evicted for a new finding", () => {
  const critical = { fp: "cccc33", finding: finding({ severity: "critical", file: "c.ts" }) };
  const existingWarning = { fp: "aaaa11", finding: finding() };
  const plan = planInlineSync({
    targets: [critical, existingWarning],
    existing: [existing({ id: 10, fp: "aaaa11", hasReplies: true })],
    maxComments: 1,
    teardown: true,
  });
  // The warning already has a live thread; the (higher-severity) newcomer waits.
  expect(plan.patch.map((p) => p.comment.fp)).toEqual(["aaaa11"]);
  expect(plan.create).toEqual([]);
  expect(plan.stub).toEqual([]);
});

test("planInlineSync: severity then fp orders admissions deterministically", () => {
  const plan = planInlineSync({
    targets: [
      { fp: "bbbb22", finding: finding({ file: "b.ts" }) },
      { fp: "aaaa11", finding: finding() },
      { fp: "cccc33", finding: finding({ severity: "critical", file: "c.ts" }) },
    ],
    existing: [],
    maxComments: 2,
    teardown: true,
  });
  expect(plan.create.map((c) => c.fp)).toEqual(["cccc33", "aaaa11"]);
});

// ---- body compare + marker scan ----

test("inlineBodiesEqual is CRLF-insensitive (the API returns CRLF bodies)", () => {
  expect(inlineBodiesEqual("a\r\nb", "a\nb")).toBe(true);
  expect(inlineBodiesEqual("a\nb", "a\nc")).toBe(false);
});

test("hasUnquotedMarker: quoted copies do not count", () => {
  const marker = inlineCommentMarker(TAG, "deadbeef11");
  expect(hasUnquotedMarker(`${marker}\nbody`, marker)).toBe(true);
  expect(hasUnquotedMarker(`> ${marker}\nmy actual reply`, marker)).toBe(false);
});

// ---- reply-matcher backstop ----

test("hasUnquotedInlineMarker: tag-independent, unquoted lines only", () => {
  expect(hasUnquotedInlineMarker(renderInlineCommentBody(finding(), "any-tag", "abcdef"))).toBe(
    true,
  );
  expect(hasUnquotedInlineMarker(`> <!-- any-tag:inline:fp=abcdef -->\nreal reply`)).toBe(false);
});

test("matchReplies: our inline body is never matched as a reply, even with a maintainer login", () => {
  const f = finding();
  const fp = fingerprintFinding(f);
  const body = renderInlineCommentBody(f, "some-other-tag", fp); // carries an unquoted id: token
  const records = matchReplies(
    [{ id: 5, body, login: "bot", maintainer: true }],
    [{ finding: f, fp }],
    {
      match: "both",
    },
  );
  expect(records).toEqual([]);
});

test("matchReplies: a quote-reply of an inline comment still matches", () => {
  const f = finding();
  const fp = fingerprintFinding(f);
  const quoted = renderInlineCommentBody(f, TAG, fp)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const records = matchReplies(
    [{ id: 5, body: `${quoted}\n\nThis is intentional.`, login: "author", maintainer: false }],
    [{ finding: f, fp }],
    { match: "both" },
  );
  expect(records.map((r) => r.fp)).toEqual([fp]);
  expect(records[0]!.citedId).toBe(false); // a quoted id never counts as citing
});

// ---- threadFp ----

test("matchReplies: threadFp matches in every match mode and never sets citedId", () => {
  const f = finding();
  const fp = fingerprintFinding(f);
  for (const match of ["quote", "id", "both"] as const) {
    const records = matchReplies(
      [
        {
          id: -50,
          body: "we cache these on purpose",
          login: "author",
          maintainer: false,
          threadFp: fp,
        },
      ],
      [{ finding: f, fp }],
      { match },
    );
    expect(records.map((r) => r.fp)).toEqual([fp]);
    expect(records[0]!.citedId).toBe(false);
    expect(records[0]!.commentId).toBe(-50);
  }
});

test("matchReplies: an unknown threadFp matches nothing", () => {
  const f = finding();
  const records = matchReplies(
    [{ id: -50, body: "x", login: "author", maintainer: false, threadFp: "ffffff" }],
    [{ finding: f, fp: fingerprintFinding(f) }],
    { match: "both" },
  );
  expect(records).toEqual([]);
});

// ---- cross-stream ids ----

test("replyIsNewer: magnitude within a stream, issue comments win across streams", () => {
  expect(replyIsNewer(200, 100)).toBe(true); // issue: newer wins
  expect(replyIsNewer(-200, -100)).toBe(true); // inline: raw 200 is newer than raw 100
  expect(replyIsNewer(-100, -200)).toBe(false);
  expect(replyIsNewer(100, -999)).toBe(true); // cross-stream: issue comment wins
  expect(replyIsNewer(-999, 100)).toBe(false);
});

test("matchReplies: the newer inline reply wins within the inline stream", () => {
  const f = finding();
  const fp = fingerprintFinding(f);
  const mk = (id: number, login: string): ReplyComment => ({
    id,
    body: "",
    login,
    maintainer: false,
    threadFp: fp,
  });
  const records = matchReplies([mk(-100, "older"), mk(-200, "newer")], [{ finding: f, fp }], {
    match: "both",
  });
  expect(records[0]!.by).toBe("newer");
});

test("applyPins: a cross-stream 'newer' maintainer reply never lifts a pin; same-stream magnitude does", () => {
  const record = (commentId: number): FeedbackRecord => ({
    fp: "aaaa11",
    by: "m",
    commentId,
    maintainer: true,
    citedId: true,
    applied: false,
  });
  // Pin taken against an inline reply (negative id): an issue reply cannot lift it.
  expect(applyPins([record(999)], [{ fp: "aaaa11", commentId: -100 }]).pins).toHaveLength(1);
  // A NEWER inline maintainer reply (raw 200 > raw 100) lifts it.
  expect(applyPins([record(-200)], [{ fp: "aaaa11", commentId: -100 }]).pins).toHaveLength(0);
  // An OLDER inline reply does not.
  expect(applyPins([record(-50)], [{ fp: "aaaa11", commentId: -100 }]).pins).toHaveLength(1);
});

// ---- activeFindings ----

test("activeFindings: drops dismissed, reply-cleared, and requalified findings", () => {
  const keep = { finding: finding(), fp: "keep01" };
  const dismissed = { finding: finding({ file: "b.ts" }), fp: "gone01" };
  const cleared = { finding: finding({ file: "c.ts" }), fp: "gone02" };
  const requalified = {
    finding: finding({ file: "d.ts", requalifiedBy: { prNumber: 2, file: "x", reason: "r" } }),
    fp: "gone03",
  };
  const record: FeedbackRecord = {
    fp: "gone02",
    by: "author",
    commentId: 5,
    maintainer: false,
    applied: true,
  };
  const active = activeFindings(
    [keep, dismissed, cleared, requalified],
    [{ fp: "gone01" }],
    [record],
  );
  expect(active.map((entry) => entry.fp)).toEqual(["keep01"]);
});

// ---- short form ----

test("renderMarkdown: an inlined finding renders short with the thread link; others render full", () => {
  const inlined = finding({ suggestion: "cache the observer" });
  const other = finding({ file: "b.ts", title: "Other finding", suggestion: "do the thing" });
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [inlined, other],
    summary: "s",
    incomplete: [],
  };
  const link: LinkContext = {
    repo: "o/r",
    prNumber: 1,
    inlineUrls: new Map([
      [fingerprintFinding(inlined), "https://github.com/o/r/pull/1#discussion_r123"],
    ]),
  };
  const body = renderMarkdown(review, TAG, [], link);
  expect(body).toContain("[inline comment](https://github.com/o/r/pull/1#discussion_r123)");
  // Short form: the one-line rationale survives, the suggestion moves inline-only.
  expect(body).toContain("getInstances() restarts the push token observer");
  expect(body).not.toContain("cache the observer");
  // The non-inlined finding keeps its full form.
  expect(body).toContain("**Suggestion:** do the thing");
});

test("renderMarkdown: a non-github inline URL is ignored (full form)", () => {
  const f = finding({ suggestion: "s1" });
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [f],
    summary: "s",
    incomplete: [],
  };
  const link: LinkContext = {
    repo: "o/r",
    prNumber: 1,
    inlineUrls: new Map([[fingerprintFinding(f), "https://evil.example/x"]]),
  };
  const body = renderMarkdown(review, TAG, [], link);
  expect(body).not.toContain("evil.example");
  expect(body).toContain("**Suggestion:** s1");
});
