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
});

// ---- the reporter adds and removes the label through a fake `gh` on PATH ----

// A fake `gh` that logs each call. The PR's labels come from labels.txt (one per
// line) and its issue events from events.json. FAKE_GH_LABEL_ERROR makes every
// label call fail.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
case "$*" in
  *"/labels"*)
    if [ -n "$FAKE_GH_LABEL_ERROR" ]; then echo "$FAKE_GH_LABEL_ERROR" >&2; exit 1; fi
    case "$*" in
      *"-X GET "*) if [ -f "$FAKE_GH_DIR/labels.txt" ]; then cat "$FAKE_GH_DIR/labels.txt"; fi ;;
      *) printf '[]' ;;
    esac ;;
  *"/events"*)
    if [ -f "$FAKE_GH_DIR/events.json" ]; then cat "$FAKE_GH_DIR/events.json"; else printf '[]'; fi ;;
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
  for (const name of ["PATH", "FAKE_GH_DIR", "FAKE_GH_LABEL_ERROR"]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_LABEL_ERROR;
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

// Each test uses its own PR number: the reporter caches some reads per PR.
async function post(
  prNumber: number,
  posted: CoordinatorOutput,
  opts: { labels?: string[]; labeledBy?: string; readyForHumanLabel?: string | null } = {},
): Promise<string[]> {
  if (opts.labels) {
    await writeFile(path.join(dir, "labels.txt"), opts.labels.join("\n"), "utf8");
  }
  if (opts.labeledBy) {
    await writeFile(
      path.join(dir, "events.json"),
      JSON.stringify([
        { event: "labeled", label: { name: LABEL }, actor: { login: "someone-else" } },
        { event: "unlabeled", label: { name: LABEL }, actor: { login: "someone-else" } },
        { event: "labeled", label: { name: LABEL }, actor: { login: opts.labeledBy } },
      ]),
      "utf8",
    );
  }
  const reporter = new GitHubReporter({
    prNumber,
    repo: "o/r",
    commentTag: TAG,
    ownLogin: "ecr-bot",
    linkContext: { repo: "o/r", prNumber },
    ...(opts.readyForHumanLabel === null
      ? {}
      : { readyForHumanLabel: opts.readyForHumanLabel ?? LABEL }),
  });
  await reporter.report(posted);
  return (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
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
  await writeFile(path.join(dir, "labels.txt"), LABEL, "utf8");
  await writeFile(
    path.join(dir, "events.json"),
    JSON.stringify([{ event: "labeled", label: { name: LABEL }, actor: { login: "ecr-bot" } }]),
    "utf8",
  );
  const reporter = new GitHubReporter({
    prNumber: 907,
    repo: "o/r",
    commentTag: TAG,
    ownLogin: "ecr-bot",
    linkContext: { repo: "o/r", prNumber: 907 },
    readyForHumanLabel: LABEL,
  });
  await reporter.reportAggregate(
    [
      { scope: "ios", isDefault: false, review: review() },
      { scope: "web", isDefault: false, review: review({ decision: "request_changes" }) },
    ],
    [],
  );
  const calls = (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
  expect(labelCalls(calls)).toEqual([
    "api -X DELETE repos/o/r/issues/907/labels/ready%20for%20human",
  ]);
});
