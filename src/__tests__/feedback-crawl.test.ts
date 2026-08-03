import { test, expect } from "bun:test";

import {
  crawlPrFeedback,
  allNullCrawlWarning,
  repoConfigMismatchWarning,
  formatFeedbackReport,
  aggregateFeedback,
} from "../commands/feedback.js";
import type { RawPr, PrFeedbackData, FeedbackTotals } from "../commands/feedback.js";

const pr = (over: Partial<RawPr> = {}): RawPr => ({
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  ...over,
});

const noProgress = (): void => {};

const okData = (raw: RawPr): PrFeedbackData => ({
  number: raw.number,
  title: raw.title,
  url: raw.url,
  hasComment: true,
  findings: [],
  records: [],
});

test("crawlPrFeedback: one failed PR fetch does not abort the crawl — the rest still complete", async () => {
  const prs = [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })];
  const { prs: results, failed } = await crawlPrFeedback(
    prs,
    2,
    async (raw) => {
      if (raw.number === 2) {
        throw new Error("gh api: transient 502");
      }
      return okData(raw);
    },
    noProgress,
  );

  expect(results.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 3]);
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ number: 2, error: "gh api: transient 502" });
});

test("crawlPrFeedback: every PR failing still resolves — an empty report, not a thrown error", async () => {
  const prs = [pr({ number: 1 }), pr({ number: 2 })];
  const { prs: results, failed } = await crawlPrFeedback(
    prs,
    2,
    async () => {
      throw new Error("boom");
    },
    noProgress,
  );

  expect(results).toEqual([]);
  expect(failed).toHaveLength(2);
  expect(failed.map((f) => f.number).sort((a, b) => a - b)).toEqual([1, 2]);
});

test("crawlPrFeedback: no failures yields an empty failed list and every PR in order", async () => {
  const prs = [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })];
  const { prs: results, failed } = await crawlPrFeedback(
    prs,
    4,
    async (raw) => okData(raw),
    noProgress,
  );

  expect(failed).toEqual([]);
  expect(results.map((r) => r.number)).toEqual([1, 2, 3]);
});

test("crawlPrFeedback: onProgress is called once per PR regardless of success or failure", async () => {
  const prs = [pr({ number: 1 }), pr({ number: 2 })];
  let calls = 0;
  await crawlPrFeedback(
    prs,
    2,
    async (raw) => {
      if (raw.number === 1) {
        throw new Error("nope");
      }
      return okData(raw);
    },
    () => {
      calls++;
    },
  );
  expect(calls).toBe(2);
});

// ---------------------------------------------------------------------------
// feedback-repo-config: local config vs. --repo mismatch must not fail silent
// ---------------------------------------------------------------------------

const totals = (over: Partial<FeedbackTotals> = {}): FeedbackTotals => ({
  prsScanned: 0,
  prsWithComment: 0,
  findingsSurfaced: 0,
  findingsReplied: 0,
  replyRate: 0,
  ...over,
});

test("repoConfigMismatchWarning: no warning when --repo matches the local checkout's repo", () => {
  expect(repoConfigMismatchWarning("o/r", "o/r")).toBeUndefined();
});

test("repoConfigMismatchWarning: no warning when local resolution failed/wasn't attempted", () => {
  expect(repoConfigMismatchWarning("o/r", undefined)).toBeUndefined();
});

test("repoConfigMismatchWarning: warns when --repo differs from the local checkout's repo", () => {
  const warning = repoConfigMismatchWarning("other/repo", "my/repo");
  expect(warning).toBeDefined();
  expect(warning).toContain("other/repo");
  expect(warning).toContain("my/repo");
  expect(warning).toContain("commentTag");
});

test("allNullCrawlWarning: no warning when nothing was scanned", () => {
  expect(allNullCrawlWarning(totals({ prsScanned: 0, prsWithComment: 0 }))).toBeUndefined();
});

test("allNullCrawlWarning: no warning when at least one PR had a bot comment", () => {
  expect(allNullCrawlWarning(totals({ prsScanned: 5, prsWithComment: 1 }))).toBeUndefined();
});

test("allNullCrawlWarning: warns when PRs were scanned but none had a bot comment", () => {
  const warning = allNullCrawlWarning(totals({ prsScanned: 5, prsWithComment: 0 }));
  expect(warning).toBeDefined();
  expect(warning).toContain("0/5");
});

test("formatFeedbackReport: surfaces the all-null-crawl warning inline in the totals section", () => {
  const report = aggregateFeedback([
    {
      number: 1,
      title: "t",
      url: "https://github.com/o/r/pull/1",
      hasComment: false,
      findings: [],
      records: [],
    },
  ]);
  const text = formatFeedbackReport(report);
  expect(text).toContain("no PRs had a matching review comment");
});

test("formatFeedbackReport: omits the all-null-crawl warning when a PR had a comment", () => {
  const report = aggregateFeedback([
    {
      number: 1,
      title: "t",
      url: "https://github.com/o/r/pull/1",
      hasComment: true,
      findings: [],
      records: [],
    },
  ]);
  const text = formatFeedbackReport(report);
  expect(text).not.toContain("no PRs had a matching review comment");
});
