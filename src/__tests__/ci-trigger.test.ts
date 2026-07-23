import { test, expect } from "bun:test";

import { shouldReview } from "../commands/ci.js";

const policy = { trigger: "all" as const, label: "ai-review", skipLabel: "ai-review:skip" };
const labelMode = { ...policy, trigger: "label" as const };

test('trigger "all": reviews every PR when not skipped', () => {
  expect(shouldReview([], policy).review).toBe(true);
  expect(shouldReview(["something-else"], policy).review).toBe(true);
});

test('skipLabel always wins (exact match), even in "all" mode', () => {
  expect(shouldReview(["ai-review:skip"], policy).review).toBe(false);
  // present alongside an opt-in label → still skipped
  expect(shouldReview(["ai-review", "ai-review:skip"], labelMode).review).toBe(false);
});

test('trigger "label": requires the opt-in label or a label:<agent> variant', () => {
  expect(shouldReview([], labelMode).review).toBe(false);
  expect(shouldReview(["ai-review"], labelMode).review).toBe(true);
  expect(shouldReview(["ai-review:correctness"], labelMode).review).toBe(true);
  expect(shouldReview(["unrelated"], labelMode).review).toBe(false);
});

test("the skip label does not count as the opt-in label (no substring match)", () => {
  // ai-review:skip must not satisfy the ai-review opt-in in label mode.
  expect(shouldReview(["ai-review:skip"], labelMode).review).toBe(false);
});

test("custom label names are honored", () => {
  const custom = { trigger: "label" as const, label: "please-review", skipLabel: "no-review" };
  expect(shouldReview(["please-review"], custom).review).toBe(true);
  expect(shouldReview(["no-review"], custom).review).toBe(false);
});
