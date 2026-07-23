import { readFile } from "node:fs/promises";

import { loadAuthFromRoot, loadReviewConfig, loadScopeConfig } from "../config/load.js";
import {
  loadRoutingManifest,
  resolveScopes,
  scopedCommentTag,
  formatOwnerTable,
} from "../config/routing.js";
import type { LoadedConfig, RoutingManifest } from "../config/schema.js";
import { repoRoot, run } from "../core/exec.js";
import { errorMessage } from "../core/util.js";
import { buildDiffLineIndex } from "../core/render.js";
import type { LinkContext, ScopeReviewResult } from "../core/render.js";
import type { CoordinatorOutput } from "../core/schema.js";
import { runReview } from "../core/review.js";
import { GitHubPRSource } from "../sources/github-pr.js";
import { memoizeSource } from "../sources/source.js";
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

Monorepos: when .expo-code-review/routing.jsonc exists, ci fans out INTERNALLY —
it assigns each changed file to exactly one scope (last-match-wins) and reviews
each active scope over only its files, then renders one aggregated comment (or one
per scope). With no manifest, behavior is unchanged.

Options:
  --agents <a,b>       Run only these agents (comma-separated ids); default: all
  --route              Let the router pick relevant agents from the diff
  --scopes <a,b>       Limit the fan-out to these named scopes (routing only)
  --comment <mode>     Override manifest comment mode: single | per-scope
  -h, --help           Show this help

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
  const scopesFilter = parseListFlag(argv, "--scopes");
  const commentOverride = parseCommentMode(argv);
  const root = await repoRoot();
  if (root && root !== process.cwd()) {
    process.chdir(root);
  }
  const cwd = process.cwd();

  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = await resolvePrNumber();

  if (!repo || prNumber == null) {
    process.stderr.write(
      "CI reviewer: could not determine repository or PR number from the environment. Skipping.\n",
    );
    return;
  }

  // A malformed manifest is a loud, non-blocking error (never a silent fallback).
  let manifest: RoutingManifest | null;
  try {
    manifest = await loadRoutingManifest(cwd);
  } catch (error) {
    process.stderr.write(`CI reviewer: invalid routing.jsonc: ${errorMessage(error)}\n`);
    return;
  }

  if (manifest == null) {
    await runLegacyCi(repo, prNumber, cwd, agents, route);
    return;
  }

  try {
    await runRoutedCi(manifest, repo, prNumber, cwd, agents, route, scopesFilter, commentOverride);
  } catch (error) {
    // Fan-out failures stay non-blocking (single-writer property is the point).
    process.stderr.write(`CI reviewer: routed run failed (non-blocking): ${errorMessage(error)}\n`);
  }
}

/**
 * The pre-routing single-config path. Kept byte-for-byte equivalent so that with no
 * routing.jsonc the CLI behaves exactly as before (backcompat invariant).
 */
async function runLegacyCi(
  repo: string,
  prNumber: number,
  cwd: string,
  agents: string[] | undefined,
  route: boolean,
): Promise<void> {
  let config;
  try {
    config = await loadReviewConfig(cwd);
  } catch (error) {
    process.stderr.write(`CI reviewer: ${errorMessage(error)}\n`);
    return;
  }

  // Layer-1 auth lock (mirrors doctor): when the workflow pins the expected token
  // env var name, refuse to run if the config names anything else. The workflow's
  // bash guard is a text sweep (layer 2) and can't see through JSON escapes; this
  // check compares the tokenEnv the loader actually honors.
  const expectedTokenEnv = process.env.ECR_EXPECTED_TOKEN_ENV;
  if (expectedTokenEnv && config.auth.tokenEnv !== expectedTokenEnv) {
    process.stderr.write(
      `CI reviewer: auth.tokenEnv "${config.auth.tokenEnv ?? "(none)"}" != ECR_EXPECTED_TOKEN_ENV "${expectedTokenEnv}"; refusing to run.\n`,
    );
    return;
  }

  // Config-driven trigger policy (.expo-code-review/config.jsonc → review): decide
  // whether this PR should be reviewed at all.
  const gate = shouldReview(await fetchPrLabels(repo, prNumber, cwd), config.review);
  if (!gate.review) {
    process.stderr.write(`CI reviewer: skipping — ${gate.reason}.\n`);
    return;
  }

  const reporter = new GitHubReporter({
    prNumber,
    repo,
    commentTag: config.commentTag,
    breakGlassMarker: config.breakGlassMarker,
    cwd,
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
    const review = await runReview(new GitHubPRSource({ prNumber, repo, cwd }), {
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

/** A scope's non-blocking failure placeholder (same shape as the legacy failure notice). */
function failureReview(scopeName: string, reason: string): CoordinatorOutput {
  return {
    decision: "approve_with_comments",
    findings: [],
    summary: `⚠️ The AI reviewer failed to run for scope **${scopeName}**, so those changes were **not** reviewed:\n\n> ${reason}`,
    incomplete: [],
  };
}

/** The routing fan-out: one process, N scopes reviewed sequentially, one render. */
async function runRoutedCi(
  manifest: RoutingManifest,
  repo: string,
  prNumber: number,
  cwd: string,
  agents: string[] | undefined,
  route: boolean,
  scopesFilter: string[] | undefined,
  commentOverride: "single" | "per-scope" | undefined,
): Promise<void> {
  const rootConfig = await loadReviewConfig(cwd);
  // The root/aggregate marker is the ACTUAL root-owned comment tag so the
  // pre-routing comment and its dismissal state upsert in place, not stranded
  // under a new marker (risk 8/9). manifest.defaults.commentTag is the
  // manifest-side default; when it diverges from the root config's tag (e.g. a
  // repo with a custom root tag adopts routing.jsonc without setting
  // defaults.commentTag, so Zod defaults it), keep the root config's tag and
  // warn rather than silently posting under a fresh marker and losing history.
  const rootTag = rootConfig.commentTag;
  if (manifest.defaults.commentTag !== rootConfig.commentTag) {
    process.stderr.write(
      `CI reviewer: routing.jsonc defaults.commentTag "${manifest.defaults.commentTag}" != root config.jsonc commentTag "${rootConfig.commentTag}"; using the root config's tag so the existing comment and its dismissals carry over. Set defaults.commentTag to match to silence this.\n`,
    );
  }

  // Every enforced agent must exist in the ROOT roster (it is the source of truth).
  const missing = manifest.defaults.enforceAgents.filter(
    (id) => !rootConfig.agents.some((agent) => agent.id === id),
  );
  if (missing.length > 0) {
    process.stderr.write(
      `CI reviewer: defaults.enforceAgents references unknown root agent(s): ${missing.join(", ")}. Skipping.\n`,
    );
    return;
  }

  // Layer-1 auth lock (mirrors doctor): when the workflow pins the expected token
  // env var name, refuse to run if the HONORED auth (routing.jsonc defaults.auth
  // when present, else the root config.jsonc) names anything else. The workflow's
  // bash guard is a text sweep (layer 2) and can't see through JSON escapes; this
  // check compares the tokenEnv the loader actually honors, so a PR-supplied
  // defaults.auth can never repoint the forwarded credential.
  const expectedTokenEnv = process.env.ECR_EXPECTED_TOKEN_ENV;
  if (expectedTokenEnv) {
    const honored = loadAuthFromRoot(rootConfig, manifest);
    if (honored.tokenEnv !== expectedTokenEnv) {
      process.stderr.write(
        `CI reviewer: honored auth.tokenEnv "${honored.tokenEnv ?? "(none)"}" != ECR_EXPECTED_TOKEN_ENV "${expectedTokenEnv}"; refusing to run.\n`,
      );
      return;
    }
  }

  // Trigger policy is central (infra-owned): the ROOT config's `review` block
  // gates the whole routed run — scope configs never widen or narrow the trigger.
  const gate = shouldReview(await fetchPrLabels(repo, prNumber, cwd), rootConfig.review);
  if (!gate.review) {
    process.stderr.write(`CI reviewer: skipping — ${gate.reason}.\n`);
    return;
  }

  const source = memoizeSource(new GitHubPRSource({ prNumber, repo, cwd }));
  const changed = await source.getChangedFiles();
  const resolution = resolveScopes(
    manifest,
    changed.map((file) => file.path),
  );

  process.stderr.write("CI reviewer: scope ownership —\n");
  for (const line of formatOwnerTable(resolution)) {
    process.stderr.write(`${line}\n`);
  }
  for (const overlap of resolution.overlaps) {
    process.stderr.write(
      `CI reviewer: ⚠ ${overlap.file} matched ${overlap.matched.join(", ")} → ${overlap.winner} wins\n`,
    );
  }
  if (resolution.unmatched.length > 0) {
    process.stderr.write(
      `CI reviewer: ⚠ ${resolution.unmatched.length} changed file(s) matched no scope (add a **/* catch-all).\n`,
    );
  }

  // Filter to named scopes AFTER resolution, so unmatched/overlaps stay honest.
  let active = resolution.active;
  if (scopesFilter) {
    const known = new Set(manifest.scopes.map((scope) => scope.name));
    const unknown = scopesFilter.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      process.stderr.write(`CI reviewer: unknown scope(s) in --scopes: ${unknown.join(", ")}\n`);
    }
    active = active.filter((scope) => scopesFilter.includes(scope.name));
  }

  const mode = commentOverride ?? manifest.comment;

  // Break-glass: ONE check via a reporter on the root marker, before fan-out.
  const bgReporter = new GitHubReporter({
    prNumber,
    repo,
    commentTag: rootTag,
    breakGlassMarker: rootConfig.breakGlassMarker,
    cwd,
  });
  try {
    if (await bgReporter.checkBreakGlass()) {
      process.stderr.write(`CI reviewer: ${rootConfig.breakGlassMarker} detected; skipping.\n`);
      await bgReporter.postSkipNote();
      await source.dispose();
      return;
    }
  } catch (error) {
    process.stderr.write(
      `CI reviewer: break-glass check failed (continuing): ${errorMessage(error)}\n`,
    );
  }

  // Build ONE link context for all scopes (rate-limit hygiene): diff lines from the
  // already-fetched changed files, base SHA via a single `gh pr view`.
  const link: LinkContext = {
    repo,
    prNumber,
    diffLines: buildDiffLineIndex(changed.map((file) => ({ path: file.path, patch: file.patch }))),
  };
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "view", String(prNumber), "--repo", repo, "--json", "baseRefOid"],
      { cwd },
    );
    const oid = (JSON.parse(stdout) as { baseRefOid?: string }).baseRefOid;
    if (oid) {
      link.baseSha = oid;
    }
  } catch {
    // leave baseSha unset → out-of-diff findings degrade to plain text
  }

  // Divide the passes budget across active scopes (risk 4), floored so a single
  // scope still gets a workable window.
  const budget = Math.max(10 * 60_000, Math.floor((32 * 60_000) / Math.max(1, active.length)));

  const results: ScopeReviewResult[] = [];
  for (const scope of active) {
    const scopeDef = manifest.scopes.find((entry) => entry.name === scope.name)!;
    const isDefault = scope.configDir === ".";
    let review: CoordinatorOutput;
    try {
      const config = await loadScopeConfig(cwd, scopeDef, manifest, rootConfig);
      review = await runReview(source, {
        config,
        mode: "ci",
        agents,
        route,
        includePaths: scope.files,
        passesBudgetMs: budget,
        onProgress: (message) => process.stderr.write(`[${scope.name}] ${message}\n`),
      });
    } catch (error) {
      const reason = errorMessage(error);
      process.stderr.write(`CI reviewer: [${scope.name}] failed (non-blocking): ${reason}\n`);
      review = failureReview(scope.name, reason);
    }
    results.push({ scope: scope.name, isDefault, review });
  }
  await source.dispose();

  const reporterFor = (tag: string, withLink = false): GitHubReporter =>
    new GitHubReporter({
      prNumber,
      repo,
      commentTag: tag,
      breakGlassMarker: rootConfig.breakGlassMarker,
      cwd,
      linkContext: withLink ? link : undefined,
    });

  if (mode === "single") {
    const aggregate = reporterFor(rootTag, true);
    let finalResults = results;
    if (scopesFilter) {
      // A partial run (--scopes) is authoritative ONLY for the named scopes: merge
      // the other scopes' previous results out of the existing aggregate comment's
      // state so re-running one scope doesn't silently discard the rest.
      const prior = (await aggregate.readState())?.scopes ?? [];
      const byName = new Map(results.map((result) => [result.scope, result]));
      for (const previous of prior) {
        if (!scopesFilter.includes(previous.scope) && !byName.has(previous.scope)) {
          byName.set(previous.scope, previous);
        }
      }
      // Manifest order; scopes no longer in the manifest drop out.
      finalResults = manifest.scopes
        .map((scope) => byName.get(scope.name))
        .filter((entry): entry is ScopeReviewResult => entry != null);
    }
    await aggregate.reportAggregate(finalResults, resolution.unmatched);
    // Clean up any per-scope comments from a previous per-scope run. A partial run
    // only ever touches the named scopes' comments.
    for (const scope of manifest.scopes) {
      if (scopesFilter && !scopesFilter.includes(scope.name)) {
        continue;
      }
      await reporterFor(scopedCommentTag(rootTag, scope.name)).clear();
    }
    process.stderr.write(
      `CI reviewer: posted aggregate review for ${finalResults.length} scope(s).\n`,
    );
  } else {
    for (const scope of manifest.scopes) {
      // A partial run (--scopes) must never touch the other scopes' live comments
      // (their reviews and dismissal state stay exactly as posted).
      if (scopesFilter && !scopesFilter.includes(scope.name)) {
        continue;
      }
      const reporter = reporterFor(scopedCommentTag(rootTag, scope.name), true);
      const result = results.find((entry) => entry.scope === scope.name);
      if (result) {
        await reporter.report(result.review);
      } else {
        // A reconciled scope with zero matched files gets its stale comment deleted.
        await reporter.clear();
      }
    }
    // The default scope posts under its scoped tag too, so clear the bare root-tag
    // comment once so a single→per-scope switch doesn't strand it. A partial run
    // (--scopes) skips this mode-switch cleanup: the root-tag comment may hold the
    // other scopes' aggregate results.
    if (!scopesFilter) {
      await reporterFor(rootTag).clear();
    }
    process.stderr.write("CI reviewer: posted per-scope reviews.\n");
  }
}

/**
 * Current PR labels via gh (more authoritative than the possibly-stale event
 * payload); on failure, returns [] so a label-read hiccup never silently skips a
 * PR (shouldReview defaults toward reviewing).
 */
async function fetchPrLabels(repo: string, prNumber: number, cwd: string): Promise<string[]> {
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
      { cwd },
    );
    return stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch (error) {
    process.stderr.write(
      `CI reviewer: could not read PR labels (continuing): ${errorMessage(error)}\n`,
    );
    return [];
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
  return parseListFlag(argv, "--agents");
}

/** Parse a comma-separated list flag (`--flag a,b`); undefined when absent/empty. */
function parseListFlag(argv: string[], flag: string): string[] | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  // A missing value, or the next token being another flag (e.g. `--agents --route`),
  // means no list was given — treat as "all"/absent rather than misparsing the next
  // flag as a value. Mirrors review.ts's requireValue.
  if (!value || value.startsWith("--")) {
    return undefined;
  }
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Parse `--comment single|per-scope` (undefined = use the manifest's setting). */
function parseCommentMode(argv: string[]): "single" | "per-scope" | undefined {
  const index = argv.indexOf("--comment");
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === "single" || value === "per-scope") {
    return value;
  }
  // A present-but-invalid mode (e.g. `--comment foo`) would otherwise fall back to
  // the manifest silently; warn like --scopes does for unknown scope names. A
  // missing value or a following flag is treated as absent.
  if (value && !value.startsWith("--")) {
    process.stderr.write(
      `CI reviewer: ignoring invalid --comment mode "${value}" (expected single | per-scope)\n`,
    );
  }
  return undefined;
}
