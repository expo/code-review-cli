import { test, expect } from "bun:test";

import { FeedbackRecordSchema, fingerprintFinding, parseAdjudication } from "../core/schema.js";
import type { Finding } from "../core/schema.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "Title",
  rationale: "r",
  evidence: "const somethingLongEnough = 1;",
  ...over,
});

test("fingerprint is unchanged when `agent` is set (attribution never lapses a dismissal)", () => {
  const bare = finding();
  const attributed = finding({ agent: "security" });
  expect(fingerprintFinding(attributed)).toBe(fingerprintFinding(bare));
});

test("FeedbackRecordSchema: defaults maintainer/applied to false and allows optional verdict/reason", () => {
  const parsed = FeedbackRecordSchema.parse({ fp: "abc123", by: "author", commentId: 7 });
  expect(parsed.maintainer).toBe(false);
  expect(parsed.applied).toBe(false);
  expect(parsed.verdict).toBeUndefined();
  expect(parsed.reason).toBeUndefined();
});

test("FeedbackRecordSchema: rejects an out-of-enum verdict and a non-integer commentId", () => {
  expect(
    FeedbackRecordSchema.safeParse({ fp: "a", by: "b", commentId: 1, verdict: "maybe" }).success,
  ).toBe(false);
  expect(FeedbackRecordSchema.safeParse({ fp: "a", by: "b", commentId: 1.5 }).success).toBe(false);
});

test("parseAdjudication: extracts an enum-constrained verdict/reason from model text", () => {
  const out = parseAdjudication(
    'reasoning…\n```json\n{"verdict":"accepted","reason":"fixed"}\n```',
  );
  expect(out).toEqual({ verdict: "accepted", reason: "fixed" });
});

test("parseAdjudication: reason defaults to 'other' when the model omits it", () => {
  expect(parseAdjudication('{"verdict":"unclear"}')).toEqual({
    verdict: "unclear",
    reason: "other",
  });
});

test("parseAdjudication: throws on an out-of-enum verdict (model output is untrusted)", () => {
  expect(() => parseAdjudication('{"verdict":"dismissed"}')).toThrow();
});
