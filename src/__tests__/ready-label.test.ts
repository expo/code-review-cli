import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { resetTrustedToolCache } from "../core/exec.js";
import { ReviewConfigSchema } from "../config/schema.js";
import type { CoordinatorOutput } from "../core/schema.js";
import { GitHubReporter, readyForHuman } from "../reporters/github.js";

const TAG = "expo-ai-code-reviewer";
const LABEL = "ready for human";

const review = (over: Partial<CoordinatorOutput> = {}): CoordinatorOutput => ({
  decision: "approve",
  findings: [],
  summary: "s",
  incomplete: [],
  ...over,
});

test("readyForHuman: both 'Ready for human review' decisions, every review complete", () => {
  expect(readyForHuman([review()])).toBe(true);
  expect(readyForHuman([review({ decision: "approve_with_comments" })])).toBe(true);
  expect(readyForHuman([review({ decision: "request_changes" })])).toBe(false);
  expect(readyForHuman([review({ couldNotComplete: true })])).toBe(false);
  // Partial coverage: a pass timed out, so the review may have missed something.
  expect(readyForHuman([review({ incomplete: ["security timed out"] })])).toBe(false);
  // An aggregate is as ready as its worst scope.
  expect(readyForHuman([review(), review({ decision: "request_changes" })])).toBe(false);
  expect(readyForHuman([review(), review({ couldNotComplete: true })])).toBe(false);
  expect(readyForHuman([])).toBe(false);
});

test("config: review.readyForHumanLabel is optional and never empty", () => {
  expect(ReviewConfigSchema.parse({}).review.readyForHumanLabel).toBeUndefined();
  expect(
    ReviewConfigSchema.parse({ review: { readyForHumanLabel: LABEL } }).review.readyForHumanLabel,
  ).toBe(LABEL);
  expect(ReviewConfigSchema.safeParse({ review: { readyForHumanLabel: "" } }).success).toBe(false);
  // It must not act as a trigger label.
  // Label names are unique regardless of case, so a case variant is the same label.
  for (const readyForHumanLabel of [
    "ai-review",
    "ai-review:ready",
    "ai-review:skip",
    "AI-Review",
    "AI-Review:Ready",
    "AI-Review:Skip",
  ]) {
    expect(ReviewConfigSchema.safeParse({ review: { readyForHumanLabel } }).success).toBe(false);
  }
  expect(
    ReviewConfigSchema.safeParse({
      review: { label: "review-me", readyForHumanLabel: "ai-review" },
    }).success,
  ).toBe(true);
});

// ---- the reporter adds and removes the label through a fake `gh` on PATH ----

// A fake `gh` that logs each call. The PR's labels come from labels.json, and page N
// of its issue events from events-N.json. FAKE_GH_LABEL_ERROR makes every label call
// fail, and FAKE_GH_USER_ERROR makes `gh api user` fail.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
case "$*" in
  *"/labels"*)
    if [ -n "$FAKE_GH_LABEL_ERROR" ]; then echo "$FAKE_GH_LABEL_ERROR" >&2; exit 1; fi
    case "$*" in
      *"-X GET "*) if [ -f "$FAKE_GH_DIR/labels.json" ]; then cat "$FAKE_GH_DIR/labels.json"; else printf '[]'; fi ;;
      *) printf '[]' ;;
    esac ;;
  *"/events"*)
    page=$(printf '%s' "$*" | sed -n 's/.*page=\\([0-9]*\\).*/\\1/p')
    if [ -f "$FAKE_GH_DIR/events-$page.json" ]; then cat "$FAKE_GH_DIR/events-$page.json"; else printf '[]'; fi ;;
  "api user"*)
    if [ -n "$FAKE_GH_USER_ERROR" ]; then echo "HTTP 403" >&2; exit 1; fi
    printf 'ecr-bot\\n' ;;
  *"-X GET "*"/comments"*) printf '[]' ;;
  *"-X POST "*"/comments --input "*) printf '{"id": 1}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ecr-ready-label-"));
  await writeFile(path.join(dir, "gh"), FAKE_GH, "utf8");
  await chmod(path.join(dir, "gh"), 0o755);
  await writeFile(path.join(dir, "calls.log"), "", "utf8");
  for (const name of [
    "PATH",
    "FAKE_GH_DIR",
    "FAKE_GH_LABEL_ERROR",
    "FAKE_GH_USER_ERROR",
    "GITHUB_ACTIONS",
  ]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_LABEL_ERROR;
  delete process.env.FAKE_GH_USER_ERROR;
  delete process.env.GITHUB_ACTIONS;
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

type LabelEvent = { event: "labeled" | "unlabeled"; actor: string; label?: string };

async function fixture(opts: { labels?: string[]; events?: LabelEvent[][] }): Promise<void> {
  await writeFile(
    path.join(dir, "labels.json"),
    JSON.stringify((opts.labels ?? []).map((name) => ({ name }))),
    "utf8",
  );
  for (const [index, page] of (opts.events ?? []).entries()) {
    await writeFile(
      path.join(dir, `events-${index + 1}.json`),
      JSON.stringify(
        page.map(({ event, actor, label }) => ({
          event,
          label: { name: label ?? LABEL },
          actor: { login: actor },
        })),
      ),
      "utf8",
    );
  }
}

// Each test uses its own PR number: the reporter caches some reads per PR.
function reporterFor(
  prNumber: number,
  opts: { readyForHumanLabel?: string | null; ownLogin?: string | null } = {},
): GitHubReporter {
  return new GitHubReporter({
    prNumber,
    repo: "o/r",
    commentTag: TAG,
    ...(opts.ownLogin === null ? {} : { ownLogin: opts.ownLogin ?? "ecr-bot" }),
    linkContext: { repo: "o/r", prNumber },
    ...(opts.readyForHumanLabel === null
      ? {}
      : { readyForHumanLabel: opts.readyForHumanLabel ?? LABEL }),
  });
}

async function calls(): Promise<string[]> {
  return (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
}

async function post(
  prNumber: number,
  posted: CoordinatorOutput,
  opts: { labels?: string[]; labeledBy?: string; readyForHumanLabel?: string | null } = {},
): Promise<string[]> {
  await fixture({
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.labeledBy
      ? {
          events: [
            [
              { event: "labeled", actor: "someone-else" },
              { event: "unlabeled", actor: "someone-else" },
              { event: "labeled", actor: opts.labeledBy },
            ],
          ],
        }
      : {}),
  });
  await reporterFor(prNumber, { readyForHumanLabel: opts.readyForHumanLabel }).report(posted);
  return calls();
}

const labelCalls = (calls: string[]): string[] =>
  calls.filter((call) => call.includes("/labels") && !call.includes("-X GET"));

test("report: a ready review adds the label", async () => {
  const calls = await post(901, review({ decision: "approve_with_comments" }));
  expect(labelCalls(calls)).toEqual([
    `api -X POST repos/o/r/issues/901/labels -f labels[]=${LABEL}`,
  ]);
});

test("report: a ready review leaves a label that is already there", async () => {
  const calls = await post(902, review(), { labels: [LABEL] });
  expect(labelCalls(calls)).toEqual([]);
});

test("report: a review that requests changes removes the label the bot added", async () => {
  const calls = await post(903, review({ decision: "request_changes" }), {
    labels: [LABEL],
    labeledBy: "ecr-bot",
  });
  expect(labelCalls(calls)).toEqual([
    "api -X DELETE repos/o/r/issues/903/labels/ready%20for%20human",
  ]);
});

test("report: a failed review keeps a label that a person added", async () => {
  const calls = await post(904, review({ couldNotComplete: true }), {
    labels: [LABEL],
    labeledBy: "a-maintainer",
  });
  expect(labelCalls(calls)).toEqual([]);
});

test("report: without the option, no label is read or changed", async () => {
  const calls = await post(905, review(), { readyForHumanLabel: null });
  expect(calls.filter((call) => call.includes("/labels") || call.includes("/events"))).toEqual([]);
});

test("report: a label failure does not fail the report", async () => {
  process.env.FAKE_GH_LABEL_ERROR = "HTTP 403";
  const calls = await post(906, review());
  // The comment was posted before the label call.
  expect(calls.some((call) => call.includes("-X POST repos/o/r/issues/906/comments"))).toBe(true);
});

test("reportAggregate: the worst scope decides, so one scope that requests changes removes it", async () => {
  await fixture({ labels: [LABEL], events: [[{ event: "labeled", actor: "ecr-bot" }]] });
  await reporterFor(907).reportAggregate(
    [
      { scope: "ios", isDefault: false, review: review() },
      { scope: "web", isDefault: false, review: review({ decision: "request_changes" }) },
    ],
    [],
  );
  expect(labelCalls(await calls())).toEqual([
    "api -X DELETE repos/o/r/issues/907/labels/ready%20for%20human",
  ]);
});

test("report: a label a person removed is not added again", async () => {
  await fixture({
    events: [
      [
        { event: "labeled", actor: "ecr-bot" },
        { event: "unlabeled", actor: "a-maintainer" },
      ],
    ],
  });
  await reporterFor(908).report(review());
  expect(labelCalls(await calls())).toEqual([]);
});

test("report: a label the bot removed is added again when the PR is ready", async () => {
  await fixture({
    events: [
      [
        { event: "labeled", actor: "ecr-bot" },
        { event: "unlabeled", actor: "ecr-bot" },
      ],
    ],
  });
  await reporterFor(909).report(review());
  expect(labelCalls(await calls())).toEqual([
    `api -X POST repos/o/r/issues/909/labels -f labels[]=${LABEL}`,
  ]);
});

test("report: the newest label event wins across pages of events", async () => {
  // A person added it on page 1, the bot added it again on page 2.
  const filler = Array.from({ length: 99 }, () => ({ event: "unlabeled" as const, actor: "x" }));
  await fixture({
    labels: [LABEL],
    events: [
      [{ event: "labeled", actor: "a-maintainer" }, ...filler],
      [{ event: "labeled", actor: "ecr-bot" }],
    ],
  });
  await reporterFor(910).report(review({ decision: "request_changes" }));
  const all = await calls();
  expect(all.filter((call) => call.includes("/events"))).toHaveLength(2);
  expect(labelCalls(all)).toEqual([
    "api -X DELETE repos/o/r/issues/910/labels/ready%20for%20human",
  ]);
});

test("report: with no known own login, the label is never removed", async () => {
  process.env.FAKE_GH_USER_ERROR = "1";
  await fixture({ labels: [LABEL], events: [[{ event: "labeled", actor: "ecr-bot" }]] });
  await reporterFor(911, { ownLogin: null }).report(review({ decision: "request_changes" }));
  expect(labelCalls(await calls())).toEqual([]);
});

test("report: a label spelled in another case on the PR is the same label", async () => {
  await fixture({
    labels: ["Ready For Human"],
    events: [[{ event: "labeled", actor: "ecr-bot", label: "Ready For Human" }]],
  });
  await reporterFor(914).report(review({ decision: "request_changes" }));
  // DELETE uses the PR's spelling of the label.
  expect(labelCalls(await calls())).toEqual([
    "api -X DELETE repos/o/r/issues/914/labels/Ready%20For%20Human",
  ]);
});

test("report: a person's removal of the label in another case is respected", async () => {
  await fixture({
    events: [
      [
        { event: "labeled", actor: "ecr-bot" },
        { event: "unlabeled", actor: "a-maintainer", label: "Ready For Human" },
      ],
    ],
  });
  await reporterFor(915).report(review());
  expect(labelCalls(await calls())).toEqual([]);
});

test("reportAggregate: unmatched files leave the PR not ready", async () => {
  await fixture({ labels: [LABEL], events: [[{ event: "labeled", actor: "ecr-bot" }]] });
  await reporterFor(916).reportAggregate(
    [{ scope: "ios", isDefault: false, review: review() }],
    ["scripts/release.sh"],
  );
  expect(labelCalls(await calls())).toEqual([
    "api -X DELETE repos/o/r/issues/916/labels/ready%20for%20human",
  ]);
});

test("reportAggregate: a scope with no result leaves the PR not ready", async () => {
  await fixture({});
  await reporterFor(917).reportAggregate(
    [{ scope: "ios", isDefault: false, review: review() }],
    [],
    undefined,
    { coverageComplete: false },
  );
  expect(labelCalls(await calls())).toEqual([]);
});

test("reportAggregate: every scope ready with full coverage adds the label", async () => {
  await fixture({});
  await reporterFor(918).reportAggregate(
    [
      { scope: "ios", isDefault: false, review: review() },
      { scope: "web", isDefault: false, review: review({ decision: "approve_with_comments" }) },
    ],
    [],
    undefined,
    { coverageComplete: true },
  );
  expect(labelCalls(await calls())).toEqual([
    `api -X POST repos/o/r/issues/918/labels -f labels[]=${LABEL}`,
  ]);
});

test("clear: deleting the review comment removes the bot's label", async () => {
  await fixture({ labels: [LABEL], events: [[{ event: "labeled", actor: "ecr-bot" }]] });
  await reporterFor(912).clear();
  expect(labelCalls(await calls())).toEqual([
    "api -X DELETE repos/o/r/issues/912/labels/ready%20for%20human",
  ]);
});

test("postSkipNote: a skipped review removes the bot's label", async () => {
  await fixture({ labels: [LABEL], events: [[{ event: "labeled", actor: "ecr-bot" }]] });
  await reporterFor(913).postSkipNote();
  expect(labelCalls(await calls())).toEqual([
    "api -X DELETE repos/o/r/issues/913/labels/ready%20for%20human",
  ]);
});
