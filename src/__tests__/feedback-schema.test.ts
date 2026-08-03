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

// The clear gate: absent must read as "did not cite", so a record written before the
// field (or by a path that never derived it) clears nothing.
test("FeedbackRecordSchema: citedId round-trips and is undefined when absent (fail closed)", () => {
  expect(
    FeedbackRecordSchema.parse({ fp: "a", by: "b", commentId: 1, citedId: true }).citedId,
  ).toBe(true);
  expect(FeedbackRecordSchema.parse({ fp: "a", by: "b", commentId: 1 }).citedId).toBeUndefined();
});

test("FeedbackRecordSchema: author/unclearedByHuman are optional and round-trip", () => {
  const parsed = FeedbackRecordSchema.parse({
    fp: "a",
    by: "b",
    commentId: 1,
    author: true,
    unclearedByHuman: true,
  });
  expect(parsed.author).toBe(true);
  expect(parsed.unclearedByHuman).toBe(true);
  // Absent → undefined (fail-closed for the author gate; unset for the pin).
  const bare = FeedbackRecordSchema.parse({ fp: "a", by: "b", commentId: 1 });
  expect(bare.author).toBeUndefined();
  expect(bare.unclearedByHuman).toBeUndefined();
});

// A verdict judges SOURCE, so it is stored with the revision it judged. A record
// written before the field existed parses fine and reads as unknown source, which
// mergeFeedback treats as stale (never as "trust it forever").
test("FeedbackRecordSchema: sourceSha is optional and round-trips with the verdict", () => {
  const parsed = FeedbackRecordSchema.parse({
    fp: "a",
    by: "b",
    commentId: 1,
    verdict: "accepted",
    sourceSha: "deadbeefcafe",
  });
  expect(parsed.sourceSha).toBe("deadbeefcafe");
  const legacy = FeedbackRecordSchema.parse({
    fp: "a",
    by: "b",
    commentId: 1,
    verdict: "accepted",
  });
  expect(legacy.sourceSha).toBeUndefined();
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
