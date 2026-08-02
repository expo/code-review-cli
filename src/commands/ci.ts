// @ref LLP 0007#ecr-ci-the-trusted-root-run — fails CLOSED: trusted-root materialization failure never falls back to reading the checkout
import { readFile } from "node:fs/promises";

import path from "node:path";

import {
  CONFIG_DIRNAME,
  hasScopeConfig,
  loadAuthFromRoot,
  loadReviewConfig,
  loadScopeConfig,
  tokenEnvMismatch,
} from "../config/load.js";
import {
  loadRoutingManifest,
  resolveScopes,
  scopedCommentTag,
  scopePassesBudgetMs,
  formatOwnerTable,
} from "../config/routing.js";
import type { LoadedConfig, RoutingManifest } from "../config/schema.js";
import { repoRoot, resolveTrustedTool, run } from "../core/exec.js";
import { errorMessage, publicFailureReason } from "../core/util.js";
import { readContextFile } from "../core/context-file.js";
import { buildDiffLineIndex } from "../core/render.js";
import type { LinkContext, ScopeReviewResult } from "../core/render.js";
import type { CoordinatorOutput, FeedbackRecord, Finding } from "../core/schema.js";
import { scopedFingerprint } from "../core/schema.js";
import { feedbackApplied, feedbackNeedsRunSeam } from "../core/adjudicate.js";
import { runReview } from "../core/review.js";
import type { ReviewRunOptions, ReviewRunResult } from "../core/review.js";
import { GitHubPRSource } from "../sources/github-pr.js";
import { memoizeSource, stackConfirmFromConfig, stackWalkFromConfig } from "../sources/source.js";
import type { PreparedReadRoot, ReviewSource, StackWalkOptions } from "../sources/source.js";
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

Trust model: review policy and reviewer configuration (config.jsonc, routing,
prompts, models, auth mapping) load from the PR's immutable BASE commit,
materialized via the GitHub API — never from the PR head — so a PR cannot change
the reviewer that evaluates it; config changes activate after merge. The PR head
is materialized separately (pinned to its immutable OID, scrubbed of ambient
runtime config) purely as source content to read and verify against. If the
trusted base cannot be materialized, the run fails closed with one terminal
comment; it never falls back to the checkout.

Monorepos: when .expo-code-review/routing.jsonc exists, ci fans out INTERNALLY —
it assigns each changed file to exactly one scope (last-match-wins) and reviews
each active scope over only its files, then renders one aggregated comment (or one
per scope). With no manifest, behavior is unchanged.

Options:
  --agents <a,b>       Run only these agents (comma-separated ids); default: all
  --route              Let the router pick relevant agents from the diff
  --scopes <a,b>       Limit the fan-out to these named scopes (routing only)
  --config-dir <dir>   Load the ROOT config.jsonc + routing.jsonc from <dir>
                       instead of .expo-code-review/ (also ECR_CONFIG_DIR). A
                       RELATIVE dir resolves beneath the trusted base commit; an
                       ABSOLUTE dir is an explicit operator trust decision. Scope
                       subtrees always resolve beneath the trusted base commit.
  --unsafe-config-from-head
                       COMPATIBILITY ESCAPE HATCH: load configuration from the
                       current checkout instead of the PR's trusted base commit.
                       This lets a same-repo PR change the reviewer (policy,
                       prompts, model, auth mapping) that evaluates itself.
                       Never scaffolded; prints a security warning; will be
                       removed on a scheduled minor boundary.
  --context-file <p>   Inject <p>'s UTF-8 text into reviewer prompts as UNTRUSTED
                       external context (missing/oversized file: warn, continue)
  --comment <mode>     Override manifest comment mode: single | per-scope
  --no-stack-aware     Force stack-aware requalification off for this run (it is
                       otherwise auto-enabled from the trusted-base stack.enabled)
  --force              Manual override: review even if the trigger policy (label
                       trigger / ai-review:skip) would skip. Break-glass and the
                       auth lock still apply. A /review comment command implies this.
  -h, --help           Show this help

Env: GITHUB_REPOSITORY, GITHUB_EVENT_PATH/GITHUB_REF (PR number), GH_TOKEN,
and model credentials per .expo-code-review/config.jsonc (or REVIEWER_MODEL).
GITHUB_EVENT_NAME=issue_comment implies --force (a /review comment command).
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
  // Stack-aware review auto-enables from the trusted-base config; this argv escape
  // hatch forces it off for one run. Safe to expose: it only ever makes the review
  // more conservative (findings stay blocking).
  const noStackAware = argv.includes("--no-stack-aware");
  // The ROOT config dir escape hatch (mirrors `ecr review`): an explicit
  // --config-dir wins, else resolveConfigDir falls back to ECR_CONFIG_DIR, else
  // the default .expo-code-review/. Applies to config.jsonc AND routing.jsonc.
  let configDir: string | undefined;
  let contextFile: string | undefined;
  try {
    configDir = parseValueFlag(argv, "--config-dir");
    contextFile = parseValueFlag(argv, "--context-file");
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${CI_USAGE}`);
    process.exitCode = 2;
    return;
  }
  // A maintainer's explicit `/review` (comment command or --force) is a manual
  // escape hatch that bypasses the trigger-policy gate only (see passesTriggerGate).
  const bypassTriggerGate = shouldBypassTriggerGate(argv);
  const unsafeConfigFromHead = argv.includes("--unsafe-config-from-head");
  const root = await repoRoot();
  if (root && root !== process.cwd()) {
    process.chdir(root);
  }
  const cwd = process.cwd();

  // @ref LLP 0007#ecr-ci-the-trusted-root-run [implements] — --context-file degrades to no-context on read error; never fails checks
  // Read the context file ONCE (routed CI runs runReview per scope; reading inside
  // would re-read it N times). CI WARNS and continues on any read error: a broken
  // Atlantis-provided plan file must never turn the PR's check red.
  let contextText: string | undefined;
  if (contextFile) {
    try {
      contextText = await readContextFile(contextFile);
    } catch (error) {
      process.stderr.write(
        `CI reviewer: --context-file unusable, continuing without it: ${errorMessage(error)}\n`,
      );
    }
    // Empty/whitespace-only plan file (e.g. Atlantis wrote nothing): warn and
    // continue with no context — never fail the check on it.
    if (contextText != null && !contextText.trim()) {
      process.stderr.write(
        `CI reviewer: --context-file ${contextFile} is empty; continuing without context.\n`,
      );
      contextText = undefined;
    }
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = await resolvePrNumber();

  if (!repo || prNumber == null) {
    process.stderr.write(
      "CI reviewer: could not determine repository or PR number from the environment. Skipping.\n",
    );
    return;
  }

  // ONE source for the whole run: metadata (incl. immutable OIDs), the diff, and
  // the PR-head read root are each fetched once and shared across scopes.
  const ghSource = new GitHubPRSource({ prNumber, repo, cwd });
  const source = memoizeSource(ghSource);

  // @ref LLP 0007#ecr-ci-the-trusted-root-run [implements] — trusted base config; fail closed with one hardcoded-tag terminal comment
  // Trusted configuration root: review policy and reviewer config load from the
  // PR's immutable BASE commit, so the PR head is data, never policy. Fail CLOSED:
  // when the base can't be materialized, post the one terminal comment and stop —
  // silently reading the checkout would let a head checkout smuggle config in.
  let trustedRoot: PreparedReadRoot | null = null;
  let configRoot = cwd;
  if (unsafeConfigFromHead) {
    process.stderr.write(
      "CI reviewer: ⚠ SECURITY — --unsafe-config-from-head is set: reviewer configuration " +
        "(policy, prompts, models, auth mapping) is being loaded from the current checkout, so " +
        "a same-repository PR can change the reviewer that evaluates it. This escape hatch will " +
        "be removed in a future minor release.\n",
    );
  } else {
    try {
      trustedRoot = await ghSource.prepareTrustedConfigRootAsync();
      configRoot = trustedRoot.dir;
    } catch (error) {
      const reason = errorMessage(error);
      process.stderr.write(
        `CI reviewer: could not materialize the PR's base commit for trusted configuration ` +
          `(failing closed, not reviewing): ${reason}\n`,
      );
      await postTerminalFailureNote(
        repo,
        prNumber,
        cwd,
        `it could not load trusted configuration from the PR's base commit (${publicFailureReason(error)}). ` +
          `This usually means the runner has no git checkout or no usable GH_TOKEN; re-run once fixed`,
      );
      return;
    }
  }

  try {
    // A malformed manifest is a loud, non-blocking error (never a silent fallback).
    let manifest: RoutingManifest | null;
    try {
      manifest = await loadRoutingManifest(configRoot, { configDir });
    } catch (error) {
      process.stderr.write(`CI reviewer: invalid routing.jsonc: ${errorMessage(error)}\n`);
      return;
    }

    if (manifest == null) {
      await runLegacyCi(source, repo, prNumber, cwd, configRoot, {
        agents,
        route,
        bypassTriggerGate,
        configDir,
        contextText,
        noStackAware,
      });
      return;
    }

    try {
      await runRoutedCi(source, manifest, repo, prNumber, cwd, configRoot, {
        agents,
        route,
        scopesFilter,
        commentOverride,
        bypassTriggerGate,
        configDir,
        contextText,
        noStackAware,
      });
    } catch (error) {
      // Fan-out failures stay non-blocking (single-writer property is the point).
      process.stderr.write(
        `CI reviewer: routed run failed (non-blocking): ${errorMessage(error)}\n`,
      );
    }
  } finally {
    await source.dispose();
    await trustedRoot?.cleanup();
  }
}

/**
 * The one terminal "this PR was NOT reviewed" comment for failures that happen
 * before any configuration is loaded (trusted-root materialization). Uses the
 * DEFAULT comment tag/break-glass marker because the config that could customize
 * them is exactly what failed to load; a repo with a custom tag gets a fresh
 * comment rather than an upsert, which is the acceptable degraded case.
 */
async function postTerminalFailureNote(
  repo: string,
  prNumber: number,
  cwd: string,
  reason: string,
): Promise<void> {
  try {
    const reporter = new GitHubReporter({
      prNumber,
      repo,
      commentTag: "expo-ai-code-reviewer",
      breakGlassMarker: "/skip-review",
      cwd,
    });
    await reporter.report({
      decision: "approve_with_comments",
      findings: [],
      summary: `⚠️ The AI reviewer failed to run, so this change was **not** reviewed: ${reason}.`,
      incomplete: [],
      couldNotComplete: true,
    });
  } catch (postError) {
    process.stderr.write(
      `CI reviewer: also failed to post the failure notice: ${errorMessage(postError)}\n`,
    );
  }
}

// @ref LLP 0011#the-rebuttal-is-a-hypothesis [constrained-by] — only "adjudicate" mode runs the model; the reporter reads the same comment it posts to, and `fpOf` keys records the same way that comment stores them, so a prior verdict carries and the same words are not re-judged
/**
 * The runReview feedback seam for a single-comment reporter. Wired when the mode
 * judges replies ("adjudicate") OR when `dismiss` is opted in — a maintainer reply
 * clearing a finding under `mode: "annotate"` needs the seam to compute `applied`,
 * with no model call (see feedbackNeedsRunSeam). Otherwise the reporter matches
 * replies itself at report time and the seam is absent (undefined). `fpOf` maps a
 * finding to the fingerprint the target comment stores its feedback under
 * (scope-namespaced for the aggregate comment, plain otherwise); omit it for the
 * plain default.
 */
function adjudicationSeam(
  config: LoadedConfig,
  reporter: GitHubReporter,
  fpOf?: (finding: Finding) => string,
): ReviewRunOptions["feedback"] {
  if (!feedbackNeedsRunSeam(config.feedback)) {
    return undefined;
  }
  return {
    config: config.feedback,
    match: (review) => reporter.matchAdjudicationItems(review, fpOf),
  };
}

/**
 * A freshly-reviewed scope's adjudicated feedback records, already keyed under the
 * scope-namespaced ids the aggregate comment renders (the single-mode seam builds them
 * with a scoped `fpOf`, see runRoutedCi), so they merge into the aggregate view as-is.
 * A carried-over prior scope (no fresh feedback) contributes nothing here.
 */
function scopeFeedbackRecords(result: ScopeReviewResult): FeedbackRecord[] {
  return (result.review as ReviewRunResult).feedback ?? [];
}

// @ref LLP 0011#the-rebuttal-is-a-hypothesis [constrained-by] — matchAdjudicationItems
// throws on a seam fetch error BY DESIGN so the legacy/per-scope paths fall back to
// computeFeedback's stored-state preservation; runReview leaves `review.feedback`
// undefined in exactly that case (never `[]` — a successful-but-empty seam sets `[]`,
// which is truthy, see scopeFeedbackRecords). This merge honors the same rule for the
// aggregate comment: a scope's fresh records are authoritative for its findings'
// fingerprints ONLY when its own seam actually returned records this run.
/**
 * The aggregate comment's feedback records for comment:'single' mode, merging:
 * - fresh records for scopes whose seam succeeded this run (`review.feedback` is an
 *   array, possibly empty) — authoritative for their findings' fingerprints, so a
 *   prior record with no fresh counterpart there means the reply is gone
 *   (deleted/edited) and is dropped;
 * - prior records for every OTHER fingerprint: carried-over scopes (a `--scopes`
 *   partial run) AND a re-reviewed scope whose seam itself failed (`review.feedback`
 *   stayed undefined) — so a transient GitHub fetch error can never delete a scope's
 *   prior reply attributions/verdicts with nothing to replace them.
 *
 * `applied` is recomputed on every kept record (idempotent for fresh ones) so a
 * carried/fallback record also honors a `dismiss` policy that changed since it was
 * stored. `results` is this run's freshly-reviewed scopes (used only to decide which
 * fingerprints are fresh-authoritative); `finalResults` is the full set the aggregate
 * comment renders (includes scopes carried over via `mergePartialAggregate`). Pure so
 * it's unit-testable.
 */
export function mergeAggregateFeedback(
  results: ScopeReviewResult[],
  finalResults: ScopeReviewResult[],
  prior: FeedbackRecord[],
  feedbackConfig: LoadedConfig["feedback"],
): FeedbackRecord[] {
  const scopedFpOf = (result: ScopeReviewResult, finding: Finding): string =>
    scopedFingerprint(result.isDefault ? null : result.scope, finding);
  const seamOkByScope = new Map(
    results.map((result) => [
      result.scope,
      (result.review as ReviewRunResult).feedback !== undefined,
    ]),
  );
  const freshFps = new Set(
    results
      .filter((result) => seamOkByScope.get(result.scope))
      .flatMap((result) => result.review.findings.map((f) => scopedFpOf(result, f))),
  );
  const byFp = new Map(
    prior.filter((record) => !freshFps.has(record.fp)).map((record) => [record.fp, record]),
  );
  for (const record of finalResults.flatMap(scopeFeedbackRecords)) {
    byFp.set(record.fp, record);
  }
  const findingByFp = new Map(
    finalResults.flatMap((result) =>
      result.review.findings.map((f) => [scopedFpOf(result, f), f] as const),
    ),
  );
  return [...byFp.values()].map((record) => {
    const finding = findingByFp.get(record.fp);
    return finding
      ? { ...record, applied: feedbackApplied(finding, record, feedbackConfig) }
      : record;
  });
}

/** Options shared by the legacy and routed CI paths (parsed from argv once). */
interface CiRunOptions {
  agents: string[] | undefined;
  route: boolean;
  scopesFilter?: string[] | undefined;
  commentOverride?: "single" | "per-scope" | undefined;
  bypassTriggerGate: boolean;
  configDir: string | undefined;
  contextText: string | undefined;
  /** --no-stack-aware: force stack-aware requalification off for this run. */
  noStackAware: boolean;
}

// @ref LLP 0010#config-and-cli-surface [implements] — under ci, stack-aware is gated by the trusted-base config; a stack walk failure only ever warns (source fails open), never a check failure
/** Resolve the walk bounds when stack-aware is on (trusted-base enabled AND not
 * forced off), else undefined (feature off → the manifest fetch is skipped). */
function resolveStackWalk(
  stack: LoadedConfig["stack"],
  noStackAware: boolean,
): StackWalkOptions | undefined {
  return stack.enabled && !noStackAware ? stackWalkFromConfig(stack) : undefined;
}

// @ref LLP 0010#patch-level-confirmation-v2 [constrained-by] — v2 rides the same trusted-base gate as the walk, plus stack.confirmWithPatch (default false, so it ships dark)
/** Resolve the v2 patch-confirmation cap when the walk is on AND confirmWithPatch is
 * set in the trusted-base config, else undefined (v2 off → grounding is the floor). */
function resolveStackConfirm(
  stack: LoadedConfig["stack"],
  noStackAware: boolean,
): { maxConfirmations: number } | undefined {
  return stack.enabled && !noStackAware ? stackConfirmFromConfig(stack) : undefined;
}

// @ref LLP 0007#ecr-ci-the-trusted-root-run [constrained-by] — run logs anchor at the workspace, never the removed-on-exit trusted root
/**
 * Run-log + patch-workspace anchor: ALWAYS the workspace checkout, never the
 * (temporary, removed-on-exit) trusted config root — the workflow uploads
 * `.expo-code-review/.runs/reviews.jsonl` from the workspace as an artifact.
 */
function workspaceRunsDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIRNAME, ".runs");
}

/**
 * The pre-routing single-config path. Kept byte-for-byte equivalent so that with no
 * routing.jsonc the CLI behaves exactly as before (backcompat invariant).
 */
async function runLegacyCi(
  source: ReviewSource,
  repo: string,
  prNumber: number,
  cwd: string,
  configRoot: string,
  options: CiRunOptions,
): Promise<void> {
  const { agents, route, bypassTriggerGate, configDir, contextText, noStackAware } = options;
  let config;
  try {
    config = await loadReviewConfig(configRoot, { configDir });
  } catch (error) {
    process.stderr.write(`CI reviewer: ${errorMessage(error)}\n`);
    return;
  }

  // @ref LLP 0007#verify-config-the-config-guard [implements] — runtime auth lock; the workflow bash sweep is only layer 2
  // Layer-1 auth lock (mirrors doctor): when the workflow pins the expected token
  // env var name, refuse to run if the config names anything else. The workflow's
  // bash guard is a text sweep (layer 2) and can't see through JSON escapes; this
  // check compares the tokenEnv the loader actually honors.
  const expectedTokenEnv = process.env.ECR_EXPECTED_TOKEN_ENV;
  if (expectedTokenEnv) {
    const mismatch = tokenEnvMismatch(config.auth, expectedTokenEnv);
    if (mismatch) {
      process.stderr.write(`CI reviewer: ${mismatch}; refusing to run.\n`);
      return;
    }
  }

  // @ref LLP 0007#trigger-policy-and-break-glass [implements] — exact-match labels; /review bypasses only the trigger gate
  // Config-driven trigger policy (.expo-code-review/config.jsonc → review): decide
  // whether this PR should be reviewed at all (bypassed by a manual /review).
  if (
    !passesTriggerGate(await fetchPrLabels(repo, prNumber, cwd), config.review, bypassTriggerGate)
  ) {
    return;
  }

  const reporter = new GitHubReporter({
    prNumber,
    repo,
    commentTag: config.commentTag,
    breakGlassMarker: config.breakGlassMarker,
    cwd,
    feedback: config.feedback,
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
    const review = await runReview(source, {
      config,
      mode: "ci",
      agents,
      route,
      contextText,
      stack: resolveStackWalk(config.stack, noStackAware),
      stackConfirm: resolveStackConfirm(config.stack, noStackAware),
      runsDir: workspaceRunsDir(cwd),
      // Adjudicate mode judges the matched replies against the source before the
      // comment is rendered; annotate mode lets the reporter match them at report
      // time. Either way the feedback path is fail-open (runReview swallows its own
      // errors), so it never fails the PR's checks.
      feedback: adjudicationSeam(config, reporter),
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    await reporter.report(review, review.feedback);
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
        summary: `⚠️ The AI reviewer failed to run, so this change was **not** reviewed:\n\n> ${publicFailureReason(error)}`,
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

// @ref LLP 0007#routed-ci-fan-out [implements] — root tag wins; sequential per-scope budgets; partial --scopes merges prior state
/** The routing fan-out: one process, N scopes reviewed sequentially, one render. */
async function runRoutedCi(
  source: ReviewSource & { dispose(): Promise<void> },
  manifest: RoutingManifest,
  repo: string,
  prNumber: number,
  cwd: string,
  configRoot: string,
  options: CiRunOptions,
): Promise<void> {
  const {
    agents,
    route,
    scopesFilter,
    commentOverride,
    bypassTriggerGate,
    configDir,
    contextText,
    noStackAware,
  } = options;
  // The root config + manifest follow the override; scope configs stay
  // relative to the TRUSTED root (loadScopeConfig reads
  // <configRoot>/<scope.config>/.expo-code-review).
  const rootConfig = await loadReviewConfig(configRoot, { configDir });
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
    const mismatch = tokenEnvMismatch(honored, expectedTokenEnv);
    if (mismatch) {
      process.stderr.write(`CI reviewer: honored ${mismatch}; refusing to run.\n`);
      return;
    }
  }

  // Trigger policy is central (infra-owned): the ROOT config's `review` block
  // gates the whole routed run — scope configs never widen or narrow the trigger.
  // A manual /review bypasses this gate (break-glass + auth lock still apply).
  if (
    !passesTriggerGate(
      await fetchPrLabels(repo, prNumber, cwd),
      rootConfig.review,
      bypassTriggerGate,
    )
  ) {
    return;
  }

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
      return;
    }
  } catch (error) {
    process.stderr.write(
      `CI reviewer: break-glass check failed (continuing): ${errorMessage(error)}\n`,
    );
  }

  // Build ONE link context for all scopes (rate-limit hygiene): diff lines from the
  // already-fetched changed files, base OID from the memoized PR metadata (the same
  // immutable OID the trusted config root was materialized from).
  const link: LinkContext = {
    repo,
    prNumber,
    diffLines: buildDiffLineIndex(changed.map((file) => ({ path: file.path, patch: file.patch }))),
  };
  try {
    const { baseOid } = await source.getMetadata();
    if (baseOid) {
      link.baseSha = baseOid;
    }
  } catch {
    // leave baseSha unset → out-of-diff findings degrade to plain text
  }

  // Divide the passes budget across active scopes (risk 4), floored so a single
  // scope still gets a workable window (see budget.* in routing.jsonc). Active
  // scopes run sequentially, so N × perScope is the real wall-clock; when the
  // floor forces that past the total, keep the floor but warn loudly.
  const totalMs = manifest.budget.totalPassesMinutes * 60_000;
  const minMs = manifest.budget.minScopeMinutes * 60_000;
  const { perScopeMs: budget, overshoot } = scopePassesBudgetMs(totalMs, minMs, active.length);
  if (overshoot) {
    const expectedMinutes = Math.round((active.length * budget) / 60_000);
    process.stderr.write(
      `CI reviewer: ⚠ ${active.length} scopes × floor = ${expectedMinutes}min exceeds budget.totalPassesMinutes (${manifest.budget.totalPassesMinutes}m); expect longer runs — raise the job timeout or trim scopes.\n`,
    );
  }

  // One PR has one stack: resolve the walk once from the ROOT (trusted-base) config
  // and share it across every scope. The source memoizes the actual fetch.
  const stackWalk = resolveStackWalk(rootConfig.stack, noStackAware);
  const stackConfirm = resolveStackConfirm(rootConfig.stack, noStackAware);

  const reporterFor = (tag: string, withLink = false): GitHubReporter =>
    new GitHubReporter({
      prNumber,
      repo,
      commentTag: tag,
      breakGlassMarker: rootConfig.breakGlassMarker,
      cwd,
      linkContext: withLink ? link : undefined,
      // Root-only feedback config (see loadScopeConfig): lets a reporter posting with
      // no explicit records match replies itself (annotate mode) at report time.
      feedback: rootConfig.feedback,
    });

  // comment:'single' mode: every active scope's feedback seam AND the final
  // aggregate post target the SAME root-tag comment, so share one reporter
  // instance (and its comment-list/login cache, see GitHubReporter's
  // `fetchAllComments` TTL cache) across the whole run — a fresh reporter per
  // scope would otherwise re-fetch the paginated comment list and re-resolve
  // the bot login once per scope for the identical comment.
  const singleModeReporter = mode === "single" ? reporterFor(rootTag, true) : undefined;

  const results: ScopeReviewResult[] = [];
  for (const scope of active) {
    const scopeDef = manifest.scopes.find((entry) => entry.name === scope.name)!;
    const isDefault = scope.configDir === ".";
    let review: CoordinatorOutput;
    try {
      // A scope whose config dir doesn't exist at the TRUSTED base commit is a
      // scope this PR introduces: review it with the root config rather than
      // failing the run on exactly that PR. The scope's own config (PR-owned,
      // untrusted for this run) activates once it merges.
      let effectiveScopeDef = scopeDef;
      if (!hasScopeConfig(configRoot, scopeDef)) {
        process.stderr.write(
          `CI reviewer: [${scope.name}] no config at "${scopeDef.config}" in the PR's base ` +
            `commit (new in this PR?); reviewing with the root config — the scope's config ` +
            `takes effect after merge.\n`,
        );
        effectiveScopeDef = { ...scopeDef, config: "." };
      }
      const config = await loadScopeConfig(configRoot, effectiveScopeDef, manifest, rootConfig);
      // The seam reads the replies off the comment this scope's review will land
      // in — the aggregate (root) comment in "single" mode, the scoped comment
      // otherwise — so prior verdicts carry. The fingerprint the records are keyed
      // under must match how THAT comment stores them: scope-namespaced for the
      // aggregate comment, plain for the scoped one. Feedback is root-only, so gate on it.
      const feedbackSeam = feedbackNeedsRunSeam(rootConfig.feedback)
        ? adjudicationSeam(
            rootConfig,
            mode === "single"
              ? singleModeReporter!
              : reporterFor(scopedCommentTag(rootTag, scope.name)),
            mode === "single"
              ? (finding) => scopedFingerprint(isDefault ? null : scope.name, finding)
              : undefined,
          )
        : undefined;
      review = await runReview(source, {
        config,
        mode: "ci",
        agents,
        route,
        includePaths: scope.files,
        contextText,
        stack: stackWalk,
        stackConfirm,
        passesBudgetMs: budget,
        runsDir: workspaceRunsDir(cwd),
        feedback: feedbackSeam,
        onProgress: (message) => process.stderr.write(`[${scope.name}] ${message}\n`),
      });
    } catch (error) {
      process.stderr.write(
        `CI reviewer: [${scope.name}] failed (non-blocking): ${errorMessage(error)}\n`,
      );
      review = failureReview(scope.name, publicFailureReason(error));
    }
    results.push({ scope: scope.name, isDefault, review });
  }

  if (mode === "single") {
    const aggregate = singleModeReporter!;
    let finalResults = results;
    if (scopesFilter) {
      // A partial run (--scopes) is authoritative ONLY for the named scopes: merge
      // the other scopes' previous results out of the existing aggregate comment's
      // state so re-running one scope doesn't silently discard the rest.
      const prior = (await aggregate.readState())?.scopes ?? [];
      finalResults = mergePartialAggregate(
        results,
        prior,
        scopesFilter,
        manifest.scopes.map((scope) => scope.name),
      );
    }
    if (finalResults.length === 0) {
      // No scope has anything to report (no changed file matched any scope, and no
      // prior scope results carry over): a review of nothing is not a review, so
      // post nothing and delete a stale aggregate comment from an earlier run
      // instead of leaving it up. The unmatched-files warning stays in the job log.
      // @ref LLP 0007#routed-ci-fan-out — zero active scopes → no comment
      await aggregate.clear();
    } else {
      // A seam-backed run hands the reporter the computed records (re-keyed to the
      // scope-namespaced ids the aggregate renders under). Without the seam it
      // passes none and the reporter matches replies itself.
      const aggFeedback = feedbackNeedsRunSeam(rootConfig.feedback)
        ? mergeAggregateFeedback(
            results,
            finalResults,
            (await aggregate.readState())?.feedback ?? [],
            rootConfig.feedback,
          )
        : undefined;
      await aggregate.reportAggregate(finalResults, resolution.unmatched, aggFeedback);
    }
    // Clean up any per-scope comments from a previous per-scope run. A partial run
    // only ever touches the named scopes' comments.
    for (const scope of manifest.scopes) {
      if (scopesFilter && !scopesFilter.includes(scope.name)) {
        continue;
      }
      await reporterFor(scopedCommentTag(rootTag, scope.name)).clear();
    }
    process.stderr.write(
      finalResults.length === 0
        ? "CI reviewer: no scope matched the changed files; nothing posted.\n"
        : `CI reviewer: posted aggregate review for ${finalResults.length} scope(s).\n`,
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
        await reporter.report(result.review, (result.review as ReviewRunResult).feedback);
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
 * Merge a partial run's fresh results (--scopes) with the prior aggregate
 * comment's stored state, in manifest order. Fresh results win for their scope;
 * scopes outside the filter keep their previous result; scopes no longer in the
 * manifest drop out. Pure so it's unit-testable.
 */
export function mergePartialAggregate(
  results: ScopeReviewResult[],
  prior: ScopeReviewResult[],
  scopesFilter: string[],
  manifestScopeNames: string[],
): ScopeReviewResult[] {
  const byName = new Map(results.map((result) => [result.scope, result]));
  for (const previous of prior) {
    if (!scopesFilter.includes(previous.scope) && !byName.has(previous.scope)) {
      byName.set(previous.scope, previous);
    }
  }
  return manifestScopeNames
    .map((name) => byName.get(name))
    .filter((entry): entry is ScopeReviewResult => entry != null);
}

/**
 * Current PR labels via gh (more authoritative than the possibly-stale event
 * payload); on failure, returns [] so a label-read hiccup never silently skips a
 * PR (shouldReview defaults toward reviewing).
 */
async function fetchPrLabels(repo: string, prNumber: number, cwd: string): Promise<string[]> {
  try {
    const gh = await resolveTrustedTool("gh");
    const { stdout } = await run(
      gh,
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

/**
 * Whether an explicit manual invocation should bypass the trigger/skip gate. A
 * maintainer's `/review` is a manual escape hatch, so it must run even when the PR
 * carries the skipLabel or the trigger policy would otherwise skip it. Detected via
 * the `--force` flag OR the GitHub event being a comment command — `issue_comment`
 * only reaches `ecr ci` through a /review command workflow, never the auto
 * `pull_request` workflow. Pure (env injected) so it's unit-testable.
 */
export function shouldBypassTriggerGate(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes("--force") || env.GITHUB_EVENT_NAME === "issue_comment";
}

/**
 * Apply the trigger policy, honoring a manual-override bypass. Returns whether to
 * proceed. When a bypass overrides a gate that would have skipped, emits a stderr
 * notice so the override is visible in the job log; a normal (non-bypassed) skip
 * emits the usual skip line. The bypass affects ONLY this trigger gate —
 * break-glass and the auth lock are separate and still apply.
 */
function passesTriggerGate(
  labels: string[],
  review: LoadedConfig["review"],
  bypass: boolean,
): boolean {
  const gate = shouldReview(labels, review);
  if (gate.review) {
    return true;
  }
  if (bypass) {
    process.stderr.write(
      `CI reviewer: manual /review — bypassing trigger policy (${gate.reason}).\n`,
    );
    return true;
  }
  process.stderr.write(`CI reviewer: skipping — ${gate.reason}.\n`);
  return false;
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

/** Parse a single-value flag (`--flag value`); undefined when absent, throws when
 * present without a value (matching review.ts's requireValue). */
function parseValueFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
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
