import { test, expect } from "bun:test";

import { ReviewConfigSchema, ScopeReviewConfigSchema } from "../config/schema.js";

test("ReviewConfigSchema: feedback resolves to the asymmetric defaults when absent", () => {
  const parsed = ReviewConfigSchema.parse({});
  expect(parsed.feedback.mode).toBe("annotate");
  expect(parsed.feedback.dismiss).toBe("never");
  expect(parsed.feedback.match).toBe("both");
  expect(parsed.feedback.protectedCategories).toEqual(["secrets", "security"]);
  expect(parsed.feedback.maxAdjudications).toBe(10);
});

test("ReviewConfigSchema: maxAdjudications must be a positive integer", () => {
  expect(ReviewConfigSchema.safeParse({ feedback: { maxAdjudications: 0 } }).success).toBe(false);
  expect(ReviewConfigSchema.safeParse({ feedback: { maxAdjudications: -3 } }).success).toBe(false);
});

test("ScopeReviewConfigSchema: feedback in a scope config fails to parse (root-only lock)", () => {
  const result = ScopeReviewConfigSchema.safeParse({ feedback: { mode: "annotate" } });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(
      result.error.issues.some((issue) => /locked to the root config/.test(issue.message)),
    ).toBe(true);
  }
});

test("ScopeReviewConfigSchema: a scope with no feedback key still parses", () => {
  expect(ScopeReviewConfigSchema.safeParse({ model: "anthropic/claude-sonnet-5" }).success).toBe(
    true,
  );
});
