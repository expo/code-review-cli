import { test, expect } from "bun:test";

import {
  extractCitedFindingIds,
  extractFindingIds,
  extractQuotedLines,
  matchReplies,
  normalizeTitle,
} from "../core/responses.js";
import type { ReplyComment } from "../core/responses.js";
import { feedbackApplied } from "../core/adjudicate.js";
import type { LoadedConfig } from "../config/schema.js";
import type { Finding } from "../core/schema.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "Validation skips jobs with a custom project root",
  rationale: "r",
  ...over,
});

const reply = (over: Partial<ReplyComment> = {}): ReplyComment => ({
  id: 100,
  body: "",
  login: "author",
  maintainer: false,
  ...over,
});

// ---- normalizeTitle ----

test("normalizeTitle: strips markdown, collapses whitespace, drops trailing punctuation", () => {
  expect(normalizeTitle("`Validation`  **skips** jobs.")).toBe("validation skips jobs");
  expect(normalizeTitle("[a link](http://x)")).toBe("a link");
});

test("normalizeTitle: a rendered title equals its blockquoted copy byte-for-byte after normalizing", () => {
  const title = "Validation skips jobs with a custom project root";
  expect(normalizeTitle(`> ${title}`.replace(/^> /, ""))).toBe(normalizeTitle(title));
});

// ---- extractQuotedLines ----

test("extractQuotedLines: reads blockquotes in order, bounded, skipping fences", () => {
  const body = "> first\ntext\n> second\n```\n> fenced code line\n```\n> third";
  expect(extractQuotedLines(body)).toEqual(["first", "second", "third"]);
});

test("extractQuotedLines: strips nested markers and empty quotes", () => {
  expect(extractQuotedLines(">> nested reply\n>\n>   spaced")).toEqual(["nested reply", "spaced"]);
});

// ---- extractFindingIds ----

test("extractFindingIds: lowercases and dedupes id: tokens in the fingerprint alphabet", () => {
  expect(extractFindingIds("see id:ABC123 and id:abc123 plus id:deadbeef99")).toEqual([
    "abc123",
    "deadbeef99",
  ]);
});

// ---- extractCitedFindingIds ----

test("extractCitedFindingIds: an id inside a blockquote is not a citation by the replier", () => {
  // GitHub's "Quote reply" prefixes every line of the target comment with "> ", so a
  // quoted id may be text the untrusted PR author planted.
  expect(extractCitedFindingIds("> the reviewer said id:abc123\n\nwhat do you think?")).toEqual([]);
  expect(extractCitedFindingIds("> quoted prose\n\nagreed, id:abc123 is fine")).toEqual(["abc123"]);
  // Nested quotes count as quotes too.
  expect(extractCitedFindingIds(">> id:deadbeef99")).toEqual([]);
});

// ---- matchReplies ----

test("matchReplies: an exact quoted title records one reply", () => {
  const f = { finding: finding(), fp: "aaa111" };
  const records = matchReplies(
    [
      reply({
        body: "Re. review:\n\n> Validation skips jobs with a custom project root\n\nintentional.",
      }),
    ],
    [f],
    { match: "both" },
  );
  expect(records).toHaveLength(1);
  expect(records[0]!.fp).toBe("aaa111");
  expect(records[0]!.by).toBe("author");
  expect(records[0]!.applied).toBe(false);
});

test("matchReplies: an id token in the known set wins outright", () => {
  const f = { finding: finding(), fp: "abc123" };
  const records = matchReplies([reply({ body: "handled, see id:abc123" })], [f], { match: "id" });
  expect(records.map((r) => r.fp)).toEqual(["abc123"]);
});

test("matchReplies: a quote shared by 2+ findings records nothing (ambiguous)", () => {
  const shared = "Duplicated finding title text here";
  const findings = [
    { finding: finding({ title: shared, file: "a.ts" }), fp: "fp0000aaaa" },
    { finding: finding({ title: shared, file: "b.ts" }), fp: "fp0000bbbb" },
  ];
  expect(
    matchReplies([reply({ body: `> ${shared}\n\nnope` })], findings, { match: "quote" }),
  ).toHaveLength(0);
});

test("matchReplies: an id in the same comment resolves an otherwise-ambiguous quote", () => {
  const shared = "Duplicated finding title text here";
  const findings = [
    { finding: finding({ title: shared, file: "a.ts" }), fp: "aa00aa00aa" },
    { finding: finding({ title: shared, file: "b.ts" }), fp: "bb00bb00bb" },
  ];
  const records = matchReplies(
    [reply({ body: `> ${shared}\n\nthis one: id:aa00aa00aa` })],
    findings,
    { match: "both" },
  );
  expect(records.map((r) => r.fp)).toEqual(["aa00aa00aa"]);
});

test("matchReplies: a short quote (< 8 normalized chars) never matches", () => {
  const f = { finding: finding({ title: "ok now" }), fp: "shorty" };
  expect(matchReplies([reply({ body: "> ok now" })], [f], { match: "quote" })).toHaveLength(0);
});

test("matchReplies: a title quoted inside a fenced code block produces no record", () => {
  const f = { finding: finding(), fp: "fenced99" };
  const body = "look at this diff:\n```\n> Validation skips jobs with a custom project root\n```\n";
  expect(matchReplies([reply({ body })], [f], { match: "quote" })).toHaveLength(0);
});

test("matchReplies: our own footer quoted back at us is skipped (self-answer guard)", () => {
  const f = { finding: finding(), fp: "selfref00" };
  const body =
    "> Validation skips jobs with a custom project root\n" +
    "<!-- expo-ai-code-reviewer:state=eyJhIjoxfQ== -->";
  expect(matchReplies([reply({ body })], [f], { match: "both" })).toHaveLength(0);
});

test("matchReplies: newest comment id wins for the same finding", () => {
  const f = { finding: finding(), fp: "newest00" };
  const q = "> Validation skips jobs with a custom project root";
  const records = matchReplies(
    [
      reply({ id: 10, login: "old", body: q }),
      reply({ id: 30, login: "new", body: q }),
      reply({ id: 20, login: "mid", body: q }),
    ],
    [f],
    { match: "quote" },
  );
  expect(records).toHaveLength(1);
  expect(records[0]!.by).toBe("new");
  expect(records[0]!.commentId).toBe(30);
});

test("matchReplies: match:'id' ignores quotes; match:'quote' ignores ids", () => {
  const f = { finding: finding(), fp: "abc123" };
  const quoteOnly = reply({ body: "> Validation skips jobs with a custom project root" });
  const idOnly = reply({ body: "resolved id:abc123" });
  expect(matchReplies([quoteOnly], [f], { match: "id" })).toHaveLength(0);
  expect(matchReplies([idOnly], [f], { match: "quote" })).toHaveLength(0);
  expect(matchReplies([quoteOnly], [f], { match: "quote" })).toHaveLength(1);
  expect(matchReplies([idOnly], [f], { match: "id" })).toHaveLength(1);
});

test("matchReplies: carries the comment url and maintainer flag onto the record", () => {
  const f = { finding: finding(), fp: "withurl0" };
  const records = matchReplies(
    [
      reply({
        body: "> Validation skips jobs with a custom project root",
        url: "https://github.com/o/r/pull/1#issuecomment-9",
        maintainer: true,
      }),
    ],
    [f],
    { match: "quote" },
  );
  expect(records[0]!.url).toBe("https://github.com/o/r/pull/1#issuecomment-9");
  expect(records[0]!.maintainer).toBe(true);
});

// Finding 1fbf85c0e651, end to end: (1) the bot posts the review, so every finding
// title is public; (2) the PR author writes one of those titles on its own line inside
// an innocent question; (3) a maintainer uses "Quote reply" on that comment, which
// copies it with every line prefixed "> ". The maintainer's comment now matches the
// finding — but on text the AUTHOR wrote, so it may annotate and must never clear.
test("matchReplies: a maintainer's quote-reply to author-planted text annotates but cannot clear", () => {
  const fp = "aa11bb22cc33";
  const f = { finding: finding(), fp };
  const planted =
    "Quick question about this one:\n\n" +
    "> Validation skips jobs with a custom project root\n" +
    "> `id:aa11bb22cc33`\n\n" +
    "> is that a problem?";
  const records = matchReplies(
    [reply({ id: 200, login: "maint", maintainer: true, body: planted })],
    [f],
    { match: "both" },
  );
  // The reply is recorded (the annotation is the useful, zero-risk half)…
  expect(records).toHaveLength(1);
  expect(records[0]!.maintainer).toBe(true);
  // …but nothing in it was written by the maintainer, so it cites no id.
  expect(records[0]!.citedId).toBe(false);
  const c: LoadedConfig["feedback"] = {
    mode: "adjudicate",
    match: "both",
    dismiss: "adjudicated",
    protectedCategories: [],
    maxAdjudications: 10,
  };
  expect(feedbackApplied(f.finding, records[0]!, c)).toBe(false);
  // Control: the same maintainer citing the id in their own words does clear it.
  const cited = matchReplies(
    [
      reply({
        id: 201,
        login: "maint",
        maintainer: true,
        body: "agreed, dropping id:aa11bb22cc33",
      }),
    ],
    [f],
    { match: "both" },
  );
  expect(cited[0]!.citedId).toBe(true);
  expect(feedbackApplied(f.finding, cited[0]!, c)).toBe(true);
});

test("matchReplies: citedId is derived whatever `match` says (that knob only picks how a reply matches)", () => {
  const fp = "aa11bb22cc33";
  const f = { finding: finding(), fp };
  // match:'quote' does not use ids to MATCH, but a cited id still gates clearing.
  const quoteMatched = matchReplies(
    [
      reply({
        body: "> Validation skips jobs with a custom project root\n\npre-existing, id:aa11bb22cc33",
      }),
    ],
    [f],
    { match: "quote" },
  );
  expect(quoteMatched[0]!.citedId).toBe(true);
});

test("matchReplies: carries the PR-author flag onto the record (gates the adjudicated path)", () => {
  const f = { finding: finding(), fp: "authorfp" };
  const q = "> Validation skips jobs with a custom project root";
  const asAuthor = matchReplies([reply({ body: q, author: true })], [f], { match: "quote" });
  expect(asAuthor[0]!.author).toBe(true);
  const asThirdParty = matchReplies([reply({ body: q, author: false })], [f], { match: "quote" });
  expect(asThirdParty[0]!.author).toBe(false);
});
