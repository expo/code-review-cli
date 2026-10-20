import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { resetTrustedToolCache } from "../core/exec.js";
import { renderInlineCommentBody } from "../core/render.js";
import type { LinkContext } from "../core/render.js";
import type { Finding } from "../core/schema.js";
import { GitHubReporter, INLINE_REVIEW_BODY, inlineUrlsByFp } from "../reporters/github.js";

const TAG = "expo-ai-code-reviewer";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 5,
  title: "Observer restarts for cached instances",
  rationale: "getInstances() restarts the push token observer for cached instances.",
  ...over,
});

test("inlineUrlsByFp: maps our marked comments to their permalinks", () => {
  const ours = renderInlineCommentBody(finding(), TAG, "aaaa11");
  const urls = inlineUrlsByFp(
    [
      { id: 1, body: ours, html_url: "https://github.com/o/r/pull/7#discussion_r1" },
      { id: 2, body: renderInlineCommentBody(finding(), "other-tag", "bbbb22"), html_url: "u2" },
      { id: 3, body: "a human reply", html_url: "u3" },
      { id: 4, body: renderInlineCommentBody(finding(), TAG, "cccc33") },
    ],
    TAG,
  );
  expect([...urls]).toEqual([["aaaa11", "https://github.com/o/r/pull/7#discussion_r1"]]);
});

// ---- the sync posts new threads through a fake `gh` on PATH ----

// A fake `gh` that logs each call and answers the endpoints the inline sync uses.
// FAKE_GH_REVIEW_ERROR makes the review POST fail with that stderr,
// FAKE_GH_REVIEW_NO_ID makes it succeed with a response that has no id, and
// FAKE_GH_LIST_ERROR makes reading the review's comments fail. The review's comments
// are served from review-comments-<page>.json.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
eval "last=\\\${$#}"
case "$*" in
  "pr view"*) printf '%s' "$FAKE_GH_HEAD" ;;
  *"/reviews/99/comments"*)
    if [ -n "$FAKE_GH_LIST_ERROR" ]; then echo "$FAKE_GH_LIST_ERROR" >&2; exit 1; fi
    page=$(printf '%s' "$*" | sed -n 's/.*page=\\([0-9]*\\).*/\\1/p')
    if [ -f "$FAKE_GH_DIR/review-comments-$page.json" ]; then
      cat "$FAKE_GH_DIR/review-comments-$page.json"
    else
      printf '[]'
    fi ;;
  *"-X POST "*"/reviews --input "*)
    cp "$last" "$FAKE_GH_DIR/review.json"
    if [ -n "$FAKE_GH_REVIEW_ERROR" ]; then echo "$FAKE_GH_REVIEW_ERROR" >&2; exit 1; fi
    if [ -n "$FAKE_GH_REVIEW_NO_ID" ]; then printf '{}'; exit 0; fi
    printf '{"id": 99}' ;;
  *"-X POST "*"/comments --input "*)
    n=$(wc -l < "$FAKE_GH_DIR/calls.log" | tr -d ' ')
    printf '{"html_url": "https://github.com/o/r/pull/7#discussion_r%s"}' "$n" ;;
  *"-X GET "*"/comments"*) printf '[]' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ecr-inline-review-"));
  await writeFile(path.join(dir, "gh"), FAKE_GH, "utf8");
  await chmod(path.join(dir, "gh"), 0o755);
  await writeFile(path.join(dir, "calls.log"), "", "utf8");
  for (const name of [
    "PATH",
    "FAKE_GH_DIR",
    "FAKE_GH_HEAD",
    "FAKE_GH_REVIEW_ERROR",
    "FAKE_GH_REVIEW_NO_ID",
    "FAKE_GH_LIST_ERROR",
    "GITHUB_STEP_SUMMARY",
  ]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  process.env.FAKE_GH_HEAD = HEAD;
  delete process.env.FAKE_GH_REVIEW_ERROR;
  delete process.env.FAKE_GH_REVIEW_NO_ID;
  delete process.env.FAKE_GH_LIST_ERROR;
  delete process.env.GITHUB_STEP_SUMMARY;
  resetTrustedToolCache();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetTrustedToolCache();
  await rm(dir, { recursive: true, force: true });
});

// Two findings by default; `count` findings (one per file) for the pagination test.
async function syncNewThreads(
  prNumber: number,
  count?: number,
): Promise<{
  urls: Map<string, string>;
  calls: string[];
}> {
  const targets = count
    ? Array.from({ length: count }, (_, index) => ({
        fp: (0xa00000 + index).toString(16),
        finding: finding({ file: `f${index}.ts`, line: 1 }),
      }))
    : [
        { fp: "aaaa11", finding: finding() },
        { fp: "bbbb22", finding: finding({ file: "b.ts", line: 9, severity: "suggestion" }) },
      ];
  const reviewComments = targets.map((target, index) => ({
    id: 500 + index,
    body: renderInlineCommentBody(target.finding, TAG, target.fp),
    html_url: `https://github.com/o/r/pull/${prNumber}#discussion_r${500 + index}`,
  }));
  for (let page = 1; (page - 1) * 100 < reviewComments.length; page++) {
    await writeFile(
      path.join(dir, `review-comments-${page}.json`),
      JSON.stringify(reviewComments.slice((page - 1) * 100, page * 100)),
      "utf8",
    );
  }
  const reporter = new GitHubReporter({
    prNumber,
    repo: "o/r",
    commentTag: TAG,
    ownLogin: "ecr-bot",
    headSha: HEAD,
    inline: { enabled: true, maxComments: Math.max(20, targets.length) },
  });
  const diffLines = new Map<string, Set<number>>();
  for (const { finding: target } of targets) {
    diffLines.set(target.file, new Set([...(diffLines.get(target.file) ?? []), target.line!]));
  }
  const link: LinkContext = { repo: "o/r", prNumber, diffLines };
  // syncInline is private; the test drives it directly so the payload GitHub would
  // receive is checked without stubbing the rest of report().
  const sync = (
    reporter as unknown as {
      syncInline: (
        targets: Array<{ finding: Finding; fp: string }>,
        link: LinkContext,
        opts: { teardown: boolean },
      ) => Promise<Map<string, string>>;
    }
  ).syncInline.bind(reporter);
  const urls = await sync(targets, link, { teardown: true });
  const calls = (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
  return { urls, calls };
}

test("syncInline: posts all new threads in one COMMENT review and links each one", async () => {
  const { urls, calls } = await syncNewThreads(701);
  expect(calls.filter((call) => call.includes("-X POST"))).toEqual([
    expect.stringContaining("repos/o/r/pulls/701/reviews --input"),
  ]);
  const review = JSON.parse(await readFile(path.join(dir, "review.json"), "utf8"));
  expect(review).toMatchObject({ commit_id: HEAD, event: "COMMENT", body: INLINE_REVIEW_BODY });
  expect(
    review.comments.map((c: { path: string; line: number; side: string }) => [
      c.path,
      c.line,
      c.side,
    ]),
  ).toEqual([
    ["a.ts", 5, "RIGHT"],
    ["b.ts", 9, "RIGHT"],
  ]);
  expect(urls.get("aaaa11")).toBe("https://github.com/o/r/pull/701#discussion_r500");
  expect(urls.get("bbbb22")).toBe("https://github.com/o/r/pull/701#discussion_r501");
});

test("syncInline: a rejected review falls back to one comment per thread", async () => {
  process.env.FAKE_GH_REVIEW_ERROR = "gh: Unprocessable Entity (HTTP 422)";
  const { urls, calls } = await syncNewThreads(702);
  const posts = calls.filter((call) => call.includes("-X POST"));
  expect(posts).toHaveLength(3);
  expect(posts[0]).toContain("repos/o/r/pulls/702/reviews --input");
  expect(
    posts.slice(1).every((call) => call.includes("repos/o/r/pulls/702/comments --input")),
  ).toBe(true);
  expect([...urls.keys()].sort()).toEqual(["aaaa11", "bbbb22"]);
});

test("syncInline: a rate-limited review posts nothing else", async () => {
  process.env.FAKE_GH_REVIEW_ERROR = "gh: You have exceeded a secondary rate limit (HTTP 403)";
  const { urls, calls } = await syncNewThreads(703);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(urls.size).toBe(0);
});

test("syncInline: a created review without an id is never posted again", async () => {
  process.env.FAKE_GH_REVIEW_NO_ID = "1";
  const { urls, calls } = await syncNewThreads(704);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(urls.size).toBe(0);
});

test("syncInline: a review that fails without a 422 is not retried, since it may exist", async () => {
  process.env.FAKE_GH_REVIEW_ERROR = "gh: Bad Gateway (HTTP 502)";
  const { urls, calls } = await syncNewThreads(705);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(urls.size).toBe(0);
});

test("syncInline: a created review whose comments can't be read is not posted again", async () => {
  process.env.FAKE_GH_LIST_ERROR = "gh: Internal Server Error (HTTP 500)";
  const { urls, calls } = await syncNewThreads(706);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(urls.size).toBe(0);
});

test("syncInline: links every thread of a review with more than one page of comments", async () => {
  const { urls, calls } = await syncNewThreads(707, 150);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(calls.filter((call) => call.includes("/reviews/99/comments"))).toHaveLength(2);
  expect(urls.size).toBe(150);
});
