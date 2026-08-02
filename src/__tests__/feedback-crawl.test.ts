import { test, expect } from "bun:test";

import { crawlPrFeedback } from "../commands/feedback.js";
import type { RawPr, PrFeedbackData } from "../commands/feedback.js";

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
