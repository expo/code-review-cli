import { test, expect } from "bun:test";

import { resolvePostRepo } from "../commands/review.js";

// Regression coverage for: repo resolution used to run unconditionally, before
// runReview(), so a `gh` failure (no auth, no network, no GitHub remote, rate
// limit) aborted the whole command and the user never saw the local review.
// `resolvePostRepo` must never throw — it reports failure as data instead, so
// the caller can still run and print the review and only fail the post step.

test("resolvePostRepo: no-op when --post/--pr aren't both set (never calls resolve)", async () => {
  let called = false;
  const resolve = async () => {
    called = true;
    return "owner/repo";
  };
  expect(await resolvePostRepo({ post: false, pr: 5 }, "/cwd", resolve)).toEqual({});
  expect(await resolvePostRepo({ post: true, pr: undefined }, "/cwd", resolve)).toEqual({});
  expect(called).toBe(false);
});

test("resolvePostRepo: an explicit --repo short-circuits and never calls resolve", async () => {
  let called = false;
  const resolve = async () => {
    called = true;
    return "should-not-be-used/repo";
  };
  const result = await resolvePostRepo(
    { post: true, pr: 5, repo: "acme/widgets" },
    "/cwd",
    resolve,
  );
  expect(result).toEqual({ repo: "acme/widgets" });
  expect(called).toBe(false);
});

test("resolvePostRepo: returns the resolved repo on success", async () => {
  const resolve = async (cwd: string) => `resolved/${cwd}`;
  const result = await resolvePostRepo({ post: true, pr: 5 }, "myrepo", resolve);
  expect(result).toEqual({ repo: "resolved/myrepo" });
});

test("resolvePostRepo: a resolve() failure is captured as data, never thrown", async () => {
  const boom = new Error("gh: not authenticated");
  const resolve = async () => {
    throw boom;
  };
  const result = await resolvePostRepo({ post: true, pr: 5 }, "/cwd", resolve);
  expect(result.repo).toBeUndefined();
  expect(result.error).toBe(boom);
});
