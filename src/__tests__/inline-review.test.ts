import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { resetTrustedToolCache } from "../core/exec.js";
import {
  inlineStubBody,
  renderAggregateMarkdown,
  renderInlineCommentBody,
  renderMarkdown,
} from "../core/render.js";
import type { LinkContext } from "../core/render.js";
import { fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type { CoordinatorOutput, Finding } from "../core/schema.js";
import { GitHubReporter, ghApiFailure, inlineUrlsByFp } from "../reporters/github.js";

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
// FAKE_GH_REVIEW_ERROR makes the review POST fail with that stderr and
// FAKE_GH_REVIEW_BODY as the response body on stdout, FAKE_GH_REVIEW_NO_ID makes it
// succeed with a response that has no id, and FAKE_GH_LIST_ERROR makes reading the
// review's comments fail (only page FAKE_GH_LIST_ERROR_PAGE, when set), and
// FAKE_GH_PATCH_ERROR makes editing an existing comment fail. FAKE_GH_COMMENT_ERROR
// and FAKE_GH_COMMENT_BODY do for a single comment POST what the REVIEW pair does. The review's
// comments are served from review-comments-<page>.json, and the PR's existing review
// comments from pr-comments.json. The PR's issue comments come from
// issue-comments.json, and an issue comment edit is copied to issue-patch.json.
// FAKE_GH_PR_LIST_ERROR makes listing the PR's review comments fail.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
eval "last=\\\${$#}"
case "$*" in
  "pr view"*) printf '%s' "$FAKE_GH_HEAD" ;;
  *"/reviews/99/comments"*)
    page=$(printf '%s' "$*" | sed -n 's/.*page=\\([0-9]*\\).*/\\1/p')
    if [ -n "$FAKE_GH_LIST_ERROR" ] && [ "\${FAKE_GH_LIST_ERROR_PAGE:-$page}" = "$page" ]; then
      echo "$FAKE_GH_LIST_ERROR" >&2; exit 1
    fi
    if [ -f "$FAKE_GH_DIR/review-comments-$page.json" ]; then
      cat "$FAKE_GH_DIR/review-comments-$page.json"
    else
      printf '[]'
    fi ;;
  *"-X POST "*"/reviews --input "*)
    cp "$last" "$FAKE_GH_DIR/review.json"
    if [ -n "$FAKE_GH_REVIEW_ERROR" ]; then
      printf '%s' "$FAKE_GH_REVIEW_BODY"; echo "$FAKE_GH_REVIEW_ERROR" >&2; exit 1
    fi
    if [ -n "$FAKE_GH_REVIEW_NO_ID" ]; then printf '{}'; exit 0; fi
    printf '{"id": 99}' ;;
  *"-X POST "*"/comments --input "*)
    if [ -n "$FAKE_GH_COMMENT_ERROR" ]; then
      printf '%s' "$FAKE_GH_COMMENT_BODY"; echo "$FAKE_GH_COMMENT_ERROR" >&2; exit 1
    fi
    n=$(wc -l < "$FAKE_GH_DIR/calls.log" | tr -d ' ')
    printf '{"html_url": "https://github.com/o/r/pull/7#discussion_r%s"}' "$n" ;;
  *"-X GET "*"/issues/"*"/comments"*)
    if [ -f "$FAKE_GH_DIR/issue-comments.json" ]; then cat "$FAKE_GH_DIR/issue-comments.json"; else printf '[]'; fi ;;
  *"-X PATCH "*"/issues/comments/"*)
    cp "$last" "$FAKE_GH_DIR/issue-patch.json"
    printf '{}' ;;
  *"-X GET "*"/comments"*)
    if [ -n "$FAKE_GH_PR_LIST_ERROR" ]; then echo "$FAKE_GH_PR_LIST_ERROR" >&2; exit 1; fi
    if [ -f "$FAKE_GH_DIR/pr-comments.json" ]; then cat "$FAKE_GH_DIR/pr-comments.json"; else printf '[]'; fi ;;
  *"-X PATCH "*)
    if [ -n "$FAKE_GH_PATCH_ERROR" ]; then echo "$FAKE_GH_PATCH_ERROR" >&2; exit 1; fi
    printf '{}' ;;
  *"-X DELETE "*) ;;
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
    "FAKE_GH_REVIEW_BODY",
    "FAKE_GH_REVIEW_NO_ID",
    "FAKE_GH_LIST_ERROR",
    "FAKE_GH_LIST_ERROR_PAGE",
    "FAKE_GH_PATCH_ERROR",
    "FAKE_GH_COMMENT_ERROR",
    "FAKE_GH_COMMENT_BODY",
    "FAKE_GH_PR_LIST_ERROR",
    "GITHUB_STEP_SUMMARY",
  ]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  process.env.FAKE_GH_HEAD = HEAD;
  delete process.env.FAKE_GH_REVIEW_ERROR;
  delete process.env.FAKE_GH_REVIEW_BODY;
  delete process.env.FAKE_GH_REVIEW_NO_ID;
  delete process.env.FAKE_GH_LIST_ERROR;
  delete process.env.FAKE_GH_LIST_ERROR_PAGE;
  delete process.env.FAKE_GH_PATCH_ERROR;
  delete process.env.FAKE_GH_COMMENT_ERROR;
  delete process.env.FAKE_GH_COMMENT_BODY;
  delete process.env.FAKE_GH_PR_LIST_ERROR;
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
  expect(review).toMatchObject({ commit_id: HEAD, event: "COMMENT", body: "" });
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
  // The read-back fixture is built separately, so only this catches a lost body.
  expect(review.comments.map((c: { body: string }) => c.body)).toEqual([
    renderInlineCommentBody(finding(), TAG, "aaaa11"),
    renderInlineCommentBody(
      finding({ file: "b.ts", line: 9, severity: "suggestion" }),
      TAG,
      "bbbb22",
    ),
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

// One thread of ours from an earlier run whose finding is gone, so the sync deletes it
// after posting the new review.
async function writeStaleThread(): Promise<void> {
  await writeFile(
    path.join(dir, "pr-comments.json"),
    JSON.stringify([
      {
        id: 77,
        body: renderInlineCommentBody(finding({ file: "c.ts", line: 3 }), TAG, "dddd44"),
        user: { login: "ecr-bot" },
        html_url: "https://github.com/o/r/pull/7#discussion_r77",
      },
    ]),
    "utf8",
  );
}

test("syncInline: one run posts the review, links it, and deletes a retired thread", async () => {
  await writeStaleThread();
  const { urls, calls } = await syncNewThreads(708);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(calls.filter((call) => call.includes("-X DELETE"))).toEqual([
    expect.stringContaining("repos/o/r/pulls/comments/77"),
  ]);
  expect([...urls.keys()].sort()).toEqual(["aaaa11", "bbbb22"]);
});

test("syncInline: a rate limit while reading the review's comments stops later mutations", async () => {
  await writeStaleThread();
  process.env.FAKE_GH_LIST_ERROR = "gh: API rate limit exceeded (HTTP 429)";
  const { urls, calls } = await syncNewThreads(709);
  expect(calls.filter((call) => call.includes("-X DELETE"))).toHaveLength(0);
  expect(urls.size).toBe(0);
});

test("syncInline: a review page that fails keeps the links of the pages before it", async () => {
  process.env.FAKE_GH_LIST_ERROR = "gh: Internal Server Error (HTTP 500)";
  process.env.FAKE_GH_LIST_ERROR_PAGE = "2";
  const { urls } = await syncNewThreads(710, 150);
  expect(urls.size).toBe(100);
});

test("syncInline: a review refused for a pending review isn't posted one by one", async () => {
  await writeStaleThread();
  process.env.FAKE_GH_REVIEW_ERROR = "gh: Unprocessable Entity (HTTP 422)";
  process.env.FAKE_GH_REVIEW_BODY = JSON.stringify({
    message: "Unprocessable Entity",
    errors: ["User can only have one pending review per pull request"],
  });
  const { urls, calls } = await syncNewThreads(711);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  // Only the new threads fail: the rest of the sync still runs.
  expect(calls.filter((call) => call.includes("-X DELETE"))).toHaveLength(1);
  expect(urls.size).toBe(0);
});

test("syncInline: a review refused as spam aborts the rest of the sync", async () => {
  await writeStaleThread();
  process.env.FAKE_GH_REVIEW_ERROR = "gh: Validation Failed (HTTP 422)";
  process.env.FAKE_GH_REVIEW_BODY = JSON.stringify({
    message: "Validation Failed",
    errors: [
      { resource: "PullRequestReview", code: "custom", message: "was submitted too quickly" },
    ],
  });
  const { urls, calls } = await syncNewThreads(712);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(1);
  expect(calls.filter((call) => call.includes("-X DELETE"))).toHaveLength(0);
  expect(urls.size).toBe(0);
});

test("syncInline: a rate limit while editing a thread skips the review", async () => {
  // aaaa11's thread exists with an outdated body, so the sync patches it before it
  // posts bbbb22 in a review.
  await writeFile(
    path.join(dir, "pr-comments.json"),
    JSON.stringify([
      {
        id: 78,
        body: renderInlineCommentBody(finding({ title: "An older title" }), TAG, "aaaa11"),
        user: { login: "ecr-bot" },
        html_url: "https://github.com/o/r/pull/7#discussion_r78",
      },
    ]),
    "utf8",
  );
  process.env.FAKE_GH_PATCH_ERROR = "gh: API rate limit exceeded (HTTP 429)";
  const { calls } = await syncNewThreads(713);
  expect(calls.filter((call) => call.includes("-X PATCH"))).toHaveLength(1);
  expect(calls.filter((call) => call.includes("-X POST"))).toHaveLength(0);
});

test("syncInline: the spam throttle during the one-by-one fallback aborts the rest", async () => {
  await writeStaleThread();
  process.env.FAKE_GH_REVIEW_ERROR = "gh: Unprocessable Entity (HTTP 422)";
  process.env.FAKE_GH_REVIEW_BODY = JSON.stringify({
    message: "Unprocessable Entity",
    errors: ["Line could not be resolved"],
  });
  process.env.FAKE_GH_COMMENT_ERROR = "gh: Validation Failed (HTTP 422)";
  process.env.FAKE_GH_COMMENT_BODY = JSON.stringify({
    message: "Validation Failed",
    errors: [
      {
        resource: "PullRequestReviewComment",
        code: "custom",
        message: "was submitted too quickly",
      },
    ],
  });
  const { calls } = await syncNewThreads(714);
  expect(calls.filter((call) => call.includes("/comments --input"))).toHaveLength(1);
  expect(calls.filter((call) => call.includes("-X DELETE"))).toHaveLength(0);
});

test("ghApiFailure: keeps the response body's messages, not the body", () => {
  const json = ghApiFailure("creating the review", {
    code: 1,
    stderr: "gh: Validation Failed (HTTP 422)\n",
    stdout: JSON.stringify({
      message: "Validation Failed",
      errors: ["one", { message: "two" }, { code: "custom" }, null],
      documentation_url: "https://docs.github.com",
    }),
  });
  expect(json.message).toBe(
    "creating the review failed: gh: Validation Failed (HTTP 422): Validation Failed; one; two",
  );
  const html = ghApiFailure("creating the review", {
    code: 1,
    stderr: "gh: HTTP 502\n",
    stdout: "<html><body>Bad Gateway</body></html>",
  });
  expect(html.message).toBe("creating the review failed: gh: HTTP 502");
  const silent = ghApiFailure("creating the review", {
    code: 1,
    stderr: "",
    stdout: "",
    signal: "SIGKILL",
  });
  expect(silent.message).toBe("creating the review failed: gh exited 1 (SIGKILL)");
});

test("ghApiFailure: caps each message, not the whole text, so a late throttle survives", () => {
  const error = ghApiFailure("creating the review", {
    code: 1,
    stderr: "gh: Validation Failed (HTTP 422)",
    stdout: JSON.stringify({
      message: "Validation Failed",
      errors: [
        ...Array.from({ length: 30 }, () => ({ message: "Line could not be resolved" })),
        { message: "x".repeat(1000) },
        { message: "was submitted too quickly" },
      ],
    }),
  });
  expect(error.message).toBe(
    `creating the review failed: gh: Validation Failed (HTTP 422): Validation Failed; Line could not be resolved; ${"x".repeat(200)}; was submitted too quickly`,
  );
});

// ---- /dismiss re-renders with the live inline threads ----

test("applyDismissal: the re-rendered comment links findings with live threads, not stubs", async () => {
  const live = finding();
  const stubbed = finding({ file: "b.ts", line: 9, title: "Stubbed thread finding" });
  const dismissed = finding({ file: "c.ts", line: 3, title: "Dismissed finding" });
  const [liveFp, stubbedFp, dismissedFp] = [live, stubbed, dismissed].map(fingerprintFinding);
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [live, stubbed, dismissed],
    summary: "s",
    incomplete: [],
  };
  await writeFile(
    path.join(dir, "issue-comments.json"),
    JSON.stringify([{ id: 900, body: renderMarkdown(review, TAG), user: { login: "ecr-bot" } }]),
    "utf8",
  );
  await writeFile(
    path.join(dir, "pr-comments.json"),
    JSON.stringify([
      {
        id: 81,
        body: renderInlineCommentBody(live, TAG, liveFp!),
        user: { login: "ecr-bot" },
        html_url: "https://github.com/o/r/pull/801#discussion_r81",
      },
      {
        id: 82,
        body: inlineStubBody(TAG, stubbedFp!),
        user: { login: "ecr-bot" },
        html_url: "https://github.com/o/r/pull/801#discussion_r82",
      },
    ]),
    "utf8",
  );
  const reporter = new GitHubReporter({
    prNumber: 801,
    repo: "o/r",
    commentTag: TAG,
    ownLogin: "ecr-bot",
    headSha: HEAD,
    inline: { enabled: true, maxComments: 20 },
    linkContext: { repo: "o/r", prNumber: 801 },
  });
  await reporter.applyDismissal([dismissedFp!], []);
  const { body } = JSON.parse(await readFile(path.join(dir, "issue-patch.json"), "utf8")) as {
    body: string;
  };
  // The live thread is linked by id, not listed again.
  expect(body).toContain(`[\`id:${liveFp}\`](https://github.com/o/r/pull/801#discussion_r81)`);
  expect(body).not.toContain("**Observer restarts for cached instances**");
  // A stub is no live thread, so its finding stays listed in full.
  expect(body).toContain("**Stubbed thread finding**");
  expect(body).not.toContain("discussion_r82");
  // The dismissed finding moves to the dismissed section.
  expect(body).toContain("Dismissed on this PR (1)");
});

// A dismissal setup: the main comment, and our review comments.
// Each test uses its own PR number: the reporter caches review comments per PR.
async function dismissalFixture(
  prNumber: number,
  issueBody: string,
  threads: Array<{ id: number; body: string }>,
): Promise<GitHubReporter> {
  await writeFile(
    path.join(dir, "issue-comments.json"),
    JSON.stringify([{ id: 900, body: issueBody, user: { login: "ecr-bot" } }]),
    "utf8",
  );
  await writeFile(
    path.join(dir, "pr-comments.json"),
    JSON.stringify(
      threads.map((thread) => ({
        ...thread,
        user: { login: "ecr-bot" },
        html_url: `https://github.com/o/r/pull/${prNumber}#discussion_r${thread.id}`,
      })),
    ),
    "utf8",
  );
  return new GitHubReporter({
    prNumber,
    repo: "o/r",
    commentTag: TAG,
    ownLogin: "ecr-bot",
    headSha: HEAD,
    inline: { enabled: true, maxComments: 20 },
    linkContext: { repo: "o/r", prNumber },
  });
}

async function patchedMainComment(): Promise<string> {
  return (
    JSON.parse(await readFile(path.join(dir, "issue-patch.json"), "utf8")) as { body: string }
  ).body;
}

test("applyDismissal: /undismiss restores the thread before the main comment links it", async () => {
  const restored = finding({ title: "Restored finding" });
  const fp = fingerprintFinding(restored);
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [restored],
    summary: "s",
    incomplete: [],
  };
  const reporter = await dismissalFixture(803, renderMarkdown(review, TAG, [{ fp }]), [
    { id: 91, body: inlineStubBody(TAG, fp) },
  ]);
  await reporter.applyDismissal([], [fp]);
  const calls = (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
  const patches = calls.filter((call) => call.includes("-X PATCH"));
  // The thread PATCH comes first, then the main comment.
  expect(patches[0]).toContain("repos/o/r/pulls/comments/91");
  expect(patches[1]).toContain("repos/o/r/issues/comments/900");
  expect(await patchedMainComment()).toContain(
    `[\`id:${fp}\`](https://github.com/o/r/pull/803#discussion_r91)`,
  );
});

test("applyDismissal: a failed restore leaves the finding listed in full, not linked to a stub", async () => {
  process.env.FAKE_GH_PATCH_ERROR = "HTTP 500";
  const restored = finding({ title: "Restored finding" });
  const fp = fingerprintFinding(restored);
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [restored],
    summary: "s",
    incomplete: [],
  };
  const reporter = await dismissalFixture(804, renderMarkdown(review, TAG, [{ fp }]), [
    { id: 92, body: inlineStubBody(TAG, fp) },
  ]);
  await reporter.applyDismissal([], [fp]);
  const body = await patchedMainComment();
  expect(body).toContain("**Restored finding**");
  expect(body).not.toContain("discussion_r92");
});

test("applyDismissal: when the threads can't be listed, every finding renders in full", async () => {
  process.env.FAKE_GH_PR_LIST_ERROR = "HTTP 502";
  const live = finding();
  const other = finding({ file: "b.ts", title: "Other finding" });
  const review: CoordinatorOutput = {
    decision: "approve_with_comments",
    findings: [live, other],
    summary: "s",
    incomplete: [],
  };
  const reporter = await dismissalFixture(805, renderMarkdown(review, TAG), [
    { id: 93, body: renderInlineCommentBody(live, TAG, fingerprintFinding(live)) },
  ]);
  await reporter.applyDismissal([fingerprintFinding(other)], []);
  const body = await patchedMainComment();
  expect(body).toContain("**Observer restarts for cached instances**");
  expect(body).not.toContain("discussion_r93");
  expect(body).toContain("Dismissed on this PR (1)");
});

test("applyDismissal: an aggregate comment links threads by the scope's ids", async () => {
  const live = finding();
  const dismissed = finding({ file: "c.ts", title: "Dismissed finding" });
  const liveId = scopedFingerprint("ios", live);
  const dismissedId = scopedFingerprint("ios", dismissed);
  const issueBody = renderAggregateMarkdown(
    [
      {
        scope: "ios",
        isDefault: false,
        review: {
          decision: "approve_with_comments",
          findings: [live, dismissed],
          summary: "s",
          incomplete: [],
        },
      },
    ],
    TAG,
    [],
  );
  const reporter = await dismissalFixture(806, issueBody, [
    { id: 94, body: renderInlineCommentBody(live, TAG, liveId) },
  ]);
  const result = await reporter.applyDismissal([dismissedId], []);
  expect(result.matched).toEqual([dismissedId]);
  const body = await patchedMainComment();
  expect(body).toContain(`[\`id:${liveId}\`](https://github.com/o/r/pull/806#discussion_r94)`);
  expect(body).not.toContain("**Observer restarts for cached instances**");
});
