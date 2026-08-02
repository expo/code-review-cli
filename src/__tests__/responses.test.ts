import { test, expect } from "bun:test";

import {
  extractFindingIds,
  extractQuotedLines,
  matchReplies,
  normalizeTitle,
} from "../core/responses.js";
import type { ReplyComment } from "../core/responses.js";
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
