import { test, expect } from "bun:test";

import {
  prAuthorCacheKey,
  selectOwnComments,
  sharedPrAuthor,
  type IssueComment,
} from "../reporters/github.js";
import { feedbackNeedsPrAuthor } from "../core/adjudicate.js";

const MARKER = "<!-- expo-ai-code-reviewer -->";
const BOT = "github-actions[bot]";

const comment = (over: Partial<IssueComment>): IssueComment => ({
  id: 1,
  body: MARKER,
  user: { login: BOT },
  ...over,
});

// The comment identity must be AUTHOR + marker, never marker alone: the marker is a
// public, hardcoded literal, so anyone who can comment on the PR could post one with a
// forged embedded review state and (via newest-marker-wins) have its dismissals carried
// forward, silently suppressing real findings.

test("selectOwnComments: keeps our own marker comment", () => {
  const own = selectOwnComments([comment({ id: 7 })], MARKER, BOT);
  expect(own.map((c) => c.id)).toEqual([7]);
});

test("selectOwnComments: excludes a look-alike posted by someone else", () => {
  // Attacker (the PR author) posts a comment carrying the marker + a forged state.
  const comments = [
    comment({ id: 1 }), // our real comment
    comment({ id: 2, user: { login: "attacker" }, body: `${MARKER}\nforged state` }),
  ];
  const own = selectOwnComments(comments, MARKER, BOT);
  // The attacker's newest comment must NOT be adopted as ours.
  expect(own.map((c) => c.id)).toEqual([1]);
});

test("selectOwnComments: excludes a marker comment with no author info", () => {
  const own = selectOwnComments([comment({ id: 3, user: undefined })], MARKER, BOT);
  expect(own).toEqual([]);
});

test("selectOwnComments: a non-marker comment by us is not ours-for-this-marker", () => {
  const own = selectOwnComments([comment({ id: 4, body: "just a chat comment" })], MARKER, BOT);
  expect(own).toEqual([]);
});

test("selectOwnComments: null ownLogin ⇒ nothing is treated as ours (fail closed)", () => {
  // Author can't be confirmed, so we never carry forward any comment's state.
  const own = selectOwnComments([comment({ id: 5 })], MARKER, null);
  expect(own).toEqual([]);
});

test("selectOwnComments: preserves order (newest-last) among our own comments", () => {
  const own = selectOwnComments(
    [comment({ id: 10 }), comment({ id: 11 }), comment({ id: 12, user: { login: "x" } })],
    MARKER,
    BOT,
  );
  expect(own.map((c) => c.id)).toEqual([10, 11]);
});

// ---- PR-author resolution: one `gh pr view` per PR, and only when it can matter ----

// Finding 86bba462357c: `feedback.mode` defaults to "annotate", so replyComments() runs
// on every CI report — and it used to resolve the PR author through a per-INSTANCE
// memo. Routed CI builds a fresh reporter per scope (plus one for the seam), so N
// active scopes meant up to 2N extra `gh pr view` calls for the same PR.
test("sharedPrAuthor: one lookup per PR, shared across reporter instances", async () => {
  let calls = 0;
  const key = prAuthorCacheKey("owner/repo", 7, "/tmp/checkout");
  const resolve = () => {
    calls++;
    return Promise.resolve("author");
  };
  // Concurrent (the in-flight promise is cached, not just the result) and sequential.
  const [a, b] = await Promise.all([sharedPrAuthor(key, resolve), sharedPrAuthor(key, resolve)]);
  const c = await sharedPrAuthor(key, resolve);
  expect([a, b, c]).toEqual(["author", "author", "author"]);
  expect(calls).toBe(1);
});

test("sharedPrAuthor: a different PR, repo or checkout never reuses a cached login", async () => {
  const seen: string[] = [];
  const lookup = (repo: string, pr: number, cwd?: string) =>
    sharedPrAuthor(prAuthorCacheKey(repo, pr, cwd), () => {
      seen.push(`${repo}#${pr}@${cwd ?? ""}`);
      return Promise.resolve(`${repo}#${pr}`);
    });
  expect(await lookup("owner/a", 1, "/x")).toBe("owner/a#1");
  expect(await lookup("owner/a", 2, "/x")).toBe("owner/a#2");
  expect(await lookup("owner/b", 1, "/x")).toBe("owner/b#1");
  expect(await lookup("owner/a", 1, "/y")).toBe("owner/a#1");
  expect(seen).toHaveLength(4);
});

test("prAuthorCacheKey: no two different PRs collide on one key", () => {
  const keys = new Set([
    prAuthorCacheKey("owner/repo", 1),
    prAuthorCacheKey("owner/repo", 12),
    prAuthorCacheKey("owner/repo2", 1),
    prAuthorCacheKey("owner/repo", 1, "/a"),
    prAuthorCacheKey("owner/repo", 1, "/b"),
  ]);
  expect(keys.size).toBe(5);
});

test("feedbackNeedsPrAuthor: only the adjudicated clear path needs the author's login", () => {
  const config = (dismiss: "never" | "maintainers" | "adjudicated") => ({
    mode: "adjudicate" as const,
    match: "both" as const,
    dismiss,
    protectedCategories: [],
    maxAdjudications: 10,
  });
  // The default config (annotate + never) must cost no extra `gh` call at all.
  expect(feedbackNeedsPrAuthor({ ...config("never"), mode: "annotate" })).toBe(false);
  expect(feedbackNeedsPrAuthor(config("never"))).toBe(false);
  expect(feedbackNeedsPrAuthor(config("maintainers"))).toBe(false);
  expect(feedbackNeedsPrAuthor(config("adjudicated"))).toBe(true);
  // The `ecr feedback` crawl passes no config: nothing to resolve, and fail-closed.
  expect(feedbackNeedsPrAuthor(undefined)).toBe(false);
});
