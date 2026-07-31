import { test, expect } from "bun:test";

import { mergePartialAggregate } from "../commands/ci.js";
import type { ScopeReviewResult } from "../core/render.js";

function result(scope: string, summary = `review of ${scope}`): ScopeReviewResult {
  return {
    scope,
    isDefault: false,
    review: { decision: "approve", findings: [], summary, incomplete: [] },
  };
}

const NAMES = ["api", "web", "docs"];

test("fresh results win over prior state for the scopes in the filter", () => {
  const merged = mergePartialAggregate(
    [result("api", "fresh")],
    [result("api", "stale"), result("web")],
    ["api"],
    NAMES,
  );
  expect(merged.map((entry) => entry.scope)).toEqual(["api", "web"]);
  expect(merged[0]!.review.summary).toBe("fresh");
});

test("a filtered scope with no fresh result drops (the partial run is authoritative for it)", () => {
  const merged = mergePartialAggregate([], [result("api", "stale")], ["api"], NAMES);
  expect(merged).toEqual([]);
});

test("prior results outside the filter carry over so nothing posted is not lost", () => {
  const merged = mergePartialAggregate([], [result("web"), result("docs")], ["api"], NAMES);
  expect(merged.map((entry) => entry.scope)).toEqual(["web", "docs"]);
});

test("results come back in manifest order; scopes no longer in the manifest drop out", () => {
  const merged = mergePartialAggregate(
    [result("docs"), result("api")],
    [result("removed-scope")],
    ["api", "docs"],
    NAMES,
  );
  expect(merged.map((entry) => entry.scope)).toEqual(["api", "docs"]);
});

test("no fresh results and no prior state merge to empty (ci posts nothing for it)", () => {
  expect(mergePartialAggregate([], [], ["api"], NAMES)).toEqual([]);
});
