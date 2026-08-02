import { test, expect } from "bun:test";

import { aggregateFeedback, formatFeedbackReport } from "../commands/feedback.js";
import type { PrFeedbackData } from "../commands/feedback.js";
import type { FeedbackRecord, Finding } from "../core/schema.js";

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

// PR 100 answered the terminal-escape finding, left the null-check unanswered.
// PR 101 got the terminal-escape finding again (different code → different fp)
// and answered it too. PR 102 never got a bot comment.
const fixture: PrFeedbackData[] = [
  {
    number: 100,
    title: "Add exec wrapper",
    url: "https://github.com/o/r/pull/100",
    hasComment: true,
    findings: [
      {
        finding: finding({
          title: "Terminal escape not sanitized",
          category: "security",
          agent: "security",
        }),
        fp: "aa1",
      },
      {
        finding: finding({
          title: "Missing null check",
          category: "correctness",
          severity: "critical",
        }),
        fp: "bb1",
      },
    ],
    records: [record({ fp: "aa1", by: "author1", url: "https://github.com/o/r/pull/100#c1" })],
  },
  {
    number: 101,
    title: "More exec",
    url: "https://github.com/o/r/pull/101",
    hasComment: true,
    findings: [
      {
        finding: finding({
          title: "Terminal escape not sanitized",
          category: "security",
          agent: "security",
        }),
        fp: "aa2",
      },
    ],
    records: [record({ fp: "aa2", by: "author2", url: "https://github.com/o/r/pull/101#c1" })],
  },
  {
    number: 102,
    title: "Docs only",
    url: "https://github.com/o/r/pull/102",
    hasComment: false,
    findings: [],
    records: [],
  },
];

test("aggregateFeedback: totals count scanned/with-comment/surfaced/replied and the reply rate", () => {
  const { totals } = aggregateFeedback(fixture);
  expect(totals.prsScanned).toBe(3);
  expect(totals.prsWithComment).toBe(2);
  expect(totals.findingsSurfaced).toBe(3);
  expect(totals.findingsReplied).toBe(2);
  expect(totals.replyRate).toBeCloseTo(2 / 3);
});

test("aggregateFeedback: breakdowns split surfaced vs replied by category, severity, agent", () => {
  const report = aggregateFeedback(fixture);
  expect(report.byCategory).toEqual([
    { key: "security", findings: 2, replied: 2 },
    { key: "correctness", findings: 1, replied: 0 },
  ]);
  expect(report.bySeverity).toEqual([
    { key: "warning", findings: 2, replied: 2 },
    { key: "critical", findings: 1, replied: 0 },
  ]);
  // Attribution absent on the null-check finding → "unknown", never guessed.
  expect(report.byAgent).toEqual([
    { key: "security", findings: 2, replied: 2 },
    { key: "unknown", findings: 1, replied: 0 },
  ]);
});

test("aggregateFeedback: a title answered in 2+ PRs is a repeat offender", () => {
  const { repeatOffenders } = aggregateFeedback(fixture);
  expect(repeatOffenders).toHaveLength(1);
  expect(repeatOffenders[0]!.title).toBe("Terminal escape not sanitized");
  expect(repeatOffenders[0]!.occurrences.map((o) => o.pr)).toEqual([100, 101]);
  expect(repeatOffenders[0]!.occurrences.map((o) => o.by)).toEqual(["author1", "author2"]);
});

test("aggregateFeedback: a title recurring but NOT answered every time is not a repeat offender", () => {
  // PR 100 answers it; PR 101 surfaces the same title but nobody replies.
  const prs: PrFeedbackData[] = [
    {
      number: 100,
      title: "a",
      url: "u1",
      hasComment: true,
      findings: [{ finding: finding({ title: "Recurring issue title" }), fp: "x1" }],
      records: [record({ fp: "x1" })],
    },
    {
      number: 101,
      title: "b",
      url: "u2",
      hasComment: true,
      findings: [{ finding: finding({ title: "Recurring issue title" }), fp: "x2" }],
      records: [],
    },
  ];
  expect(aggregateFeedback(prs).repeatOffenders).toHaveLength(0);
});

test("aggregateFeedback: per-PR list only holds PRs with a reply, newest first", () => {
  const { perPr } = aggregateFeedback(fixture);
  expect(perPr.map((p) => p.pr)).toEqual([101, 100]);
  expect(perPr[1]!.findings).toEqual([
    {
      title: "Terminal escape not sanitized",
      by: "author1",
      commentUrl: "https://github.com/o/r/pull/100#c1",
    },
  ]);
});

test("formatFeedbackReport: renders totals, breakdowns, repeat offenders and per-PR sections", () => {
  const text = formatFeedbackReport(aggregateFeedback(fixture));
  expect(text).toContain("PRs scanned: 3 (2 with a bot comment)");
  expect(text).toContain("Findings with an author reply: 2 (67%)");
  expect(text).toContain("Repeat offenders");
  expect(text).toContain("Terminal escape not sanitized");
  expect(text).toContain("#101 More exec");
});

test("aggregateFeedback: an empty crawl yields zeroed totals, not a divide-by-zero", () => {
  const { totals, repeatOffenders, perPr } = aggregateFeedback([]);
  expect(totals).toEqual({
    prsScanned: 0,
    prsWithComment: 0,
    findingsSurfaced: 0,
    findingsReplied: 0,
    replyRate: 0,
  });
  expect(repeatOffenders).toEqual([]);
  expect(perPr).toEqual([]);
});
