import { readFile } from "node:fs/promises";

import type { LoadedConfig } from "../config/schema.js";
import { loadReviewConfig } from "../config/load.js";
import { repoRoot, run } from "../core/exec.js";
import { errorMessage } from "../core/util.js";
import { runReview } from "../core/review.js";
import { GitHubPRSource } from "../sources/github-pr.js";
import { GitHubReporter } from "../reporters/github.js";

/** Resolve the PR number from the Actions event payload or GITHUB_REF. */
async function resolvePrNumber(): Promise<number | null> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(await readFile(eventPath, "utf8")) as {
        pull_request?: { number?: number };
        // issue_comment events carry the PR number under issue.number.
        issue?: { number?: number };
        number?: number;
      };
      const number = event.pull_request?.number ?? event.issue?.number ?? event.number;
      if (typeof number === "number") {
        return number;
      }
    } catch {
      // fall through
    }
  }
  const match = (process.env.GITHUB_REF ?? "").match(/refs\/pull\/(\d+)\//);
  return match ? Number(match[1]) : null;
}

const CI_USAGE = `ecr ci — review the current GitHub PR and post/update one comment.

For GitHub Actions: reads the PR number + repo from the event/env, gets the diff
via \`gh pr diff\`, runs the reviewer, and upserts a single PR comment. Comment-only
and non-blocking (a reviewer failure never fails the PR's checks).

Options:
  --agents <a,b>   Run only these agents (comma-separated ids); default: all
  --route          Let the router pick relevant agents from the diff
  -h, --help       Show this help

Env: GITHUB_REPOSITORY, GITHUB_EVENT_PATH/GITHUB_REF (PR number), GH_TOKEN,
and model credentials per .expo-code-review/config.jsonc (or REVIEWER_MODEL).
`;

export async function ciCommand(argv: string[] = []): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(CI_USAGE);
    return;
  }
  const agents = parseAgents(argv);
  const route = argv.includes("--route");
  const root = await repoRoot();
  if (root && root !== process.cwd()) {
    process.chdir(root);
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = await resolvePrNumber();

  if (!repo || prNumber == null) {
    process.stderr.write(
      "CI reviewer: could not determine repository or PR number from the environment. Skipping.\n",
    );
    return;
  }

  let config;
  try {
    config = await loadReviewConfig(process.cwd());
  } catch (error) {
    process.stderr.write(`CI reviewer: ${errorMessage(error)}\n`);
    return;
  }

  // Config-driven trigger policy (.expo-code-review/config.jsonc → review): decide
  // whether this PR should be reviewed at all. Fetch current labels via gh (more
  // authoritative than the possibly-stale event payload); on failure, default to
  // reviewing so a label-read hiccup never silently skips a PR.
  let labels: string[] = [];
  try {
    const { stdout } = await run(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "labels",
        "--jq",
        ".labels[].name",
      ],
      { cwd: process.cwd() },
    );
    labels = stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch (error) {
    process.stderr.write(
      `CI reviewer: could not read PR labels (continuing): ${errorMessage(error)}\n`,
    );
  }
  const gate = shouldReview(labels, config.review);
  if (!gate.review) {
    process.stderr.write(`CI reviewer: skipping — ${gate.reason}.\n`);
    return;
  }

  const reporter = new GitHubReporter({
    prNumber,
    repo,
    commentTag: config.commentTag,
    breakGlassMarker: config.breakGlassMarker,
    cwd: process.cwd(),
  });

  try {
    if (await reporter.checkBreakGlass()) {
      process.stderr.write(`CI reviewer: ${config.breakGlassMarker} detected; skipping.\n`);
      await reporter.postSkipNote();
      return;
    }
  } catch (error) {
    process.stderr.write(
      `CI reviewer: break-glass check failed (continuing): ${errorMessage(error)}\n`,
    );
  }

  try {
    const review = await runReview(new GitHubPRSource({ prNumber, repo, cwd: process.cwd() }), {
      config,
      mode: "ci",
      agents,
      route,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    await reporter.report(review);
    process.stderr.write(`CI reviewer: posted review (${review.decision}).\n`);
  } catch (error) {
    // A reviewer failure must never fail the PR's checks — but it must also not be
    // silent. Post a terminal state to the PR so the maintainer who triggered it
    // (e.g. a `/review` with a typo'd agent name, or a crash) gets feedback
    // instead of a stuck 👀 reaction and nothing else.
    const reason = errorMessage(error);
    process.stderr.write(`CI reviewer: run failed (non-blocking): ${reason}\n`);
    try {
      await reporter.report({
        decision: "approve_with_comments",
        findings: [],
        summary: `⚠️ The AI reviewer failed to run, so this change was **not** reviewed:\n\n> ${reason}`,
        incomplete: [],
      });
    } catch (postError) {
      process.stderr.write(
        `CI reviewer: also failed to post the failure notice: ${errorMessage(postError)}\n`,
      );
    }
  }
}

/**
 * Decide whether a PR should be reviewed, given its labels and the repo's trigger
 * policy. `skipLabel` always wins (write-gated opt-out). In "label" mode a PR must
 * carry `label` or a `label:<agent>` variant; in "all" mode every non-skipped PR
 * is reviewed. Pure so it's unit-testable and matches exact label names (no
 * substring surprises like `ai-review:skip` satisfying an `ai-review` check).
 */
export function shouldReview(
  labels: string[],
  review: LoadedConfig["review"],
): { review: boolean; reason: string } {
  if (labels.includes(review.skipLabel)) {
    return { review: false, reason: `the ${review.skipLabel} label is set` };
  }
  if (review.trigger === "label") {
    const optedIn = labels.some(
      (name) => name === review.label || name.startsWith(`${review.label}:`),
    );
    return optedIn
      ? { review: true, reason: `the ${review.label} label is set` }
      : { review: false, reason: `trigger is "label" and no ${review.label} label is set` };
  }
  return { review: true, reason: 'trigger is "all"' };
}

/** Parse `--agents a,b,c` from argv (undefined = all agents). */
function parseAgents(argv: string[]): string[] | undefined {
  const index = argv.indexOf("--agents");
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  // A missing value, or the next token being another flag (e.g. `--agents --route`),
  // means no agent list was given — treat as "all" rather than misparsing `--route`
  // as an agent id. Mirrors review.ts's requireValue.
  if (!value || value.startsWith("--")) {
    return undefined;
  }
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
