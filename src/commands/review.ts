// @ref LLP 0007#ecr-review-local-trust-and-flag-rules — local runs: the person at the terminal is the trust principal, even with --pr
import { loadReviewConfig, loadScopeConfig } from "../config/load.js";
import { loadRoutingManifest, resolveScopes, scopedCommentTag } from "../config/routing.js";
import { repoRoot, resolveRepo } from "../core/exec.js";
import { errorMessage } from "../core/util.js";
import { readContextFile } from "../core/context-file.js";
import { writeDeferredReviewArtifact } from "../core/deferred-review.js";
import { feedbackNeedsRunSeam } from "../core/adjudicate.js";
import { runReview } from "../core/review.js";
import { LocalGitSource } from "../sources/local-git.js";
import { GitHubPRSource, isCommitOid } from "../sources/github-pr.js";
import type { ReviewSource } from "../sources/source.js";
import { memoizeSource, stackConfirmFromConfig, stackWalkFromConfig } from "../sources/source.js";
import { TerminalReporter } from "../reporters/terminal.js";
import { GitHubReporter } from "../reporters/github.js";

const USAGE = `ecr review — AI code review, printed to your terminal

Usage:
  ecr review [options]                 review local changes
  ecr review --pr <n> [--post | --save-review]
                                       review a GitHub PR by number

Source (pick one):
  (default)          diff the working tree against the merge-base
  --base <ref>       base ref to diff against
  --head <ref>       head ref to diff
  --staged           review only staged changes (index vs HEAD; not combinable
                     with --base/--head)
  --pr <n>           review GitHub PR #n by number (diff fetched via \`gh\`, no
                     checkout needed); can't be combined with --base/--head/--staged

Options:
  --repo <owner/repo>  repo for --pr (default: inferred from the current checkout)
  --post               with --pr: also post the result as the PR comment (needs
                       \`gh\` auth). Omit to only preview here; re-run with --post
                       to publish.
  --save-review        with explicit --repo + --pr: save this exact preview as a
                       postable artifact for a later \`ecr post-review\` command.
  --agents <a,b>       run only these agents (comma-separated ids); default: all
  --route              let the router pick relevant agents from the diff
  --scope <name>       review only this routing scope (needs a routing.jsonc);
                       runs its config over just that scope's changed files
  --config-dir <dir>   load config from <dir> instead of .expo-code-review/
                       (also ECR_CONFIG_DIR); can't combine with --scope
  --context-file <p>   inject <p>'s UTF-8 text into reviewer prompts as an
                       explicitly UNTRUSTED external-context block
  --stack-aware        with --pr: walk the open PRs stacked on top and let the
                       coordinator requalify absence-style findings a later PR
                       already addresses (off by default; rejected without --pr)
  --json               emit machine-readable JSON on stdout
  --no-fail            always exit 0, even on request-changes
  -h, --help           show this help

Note: with --repo (or in CI), --pr materializes the PR-head tree (pinned to its
immutable commit, scrubbed of ambient runtime config) so reads match the PR; if
that isn't possible, it falls back to your checked-out files with a warning.
Config always loads from YOUR checkout in local runs — you are the trust
principal here. In \`ecr ci\`, config loads from the PR's trusted base commit.

Exit codes: 0 approve / approve-with-comments, 1 request-changes, 2 error.
`;

export interface ReviewArgs {
  base?: string;
  head?: string;
  staged: boolean;
  pr?: number;
  repo?: string;
  post: boolean;
  saveReview: boolean;
  agents?: string[];
  route: boolean;
  scope?: string;
  configDir?: string;
  contextFile?: string;
  stackAware: boolean;
  json: boolean;
  noFail: boolean;
  help: boolean;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = {
    staged: false,
    post: false,
    saveReview: false,
    route: false,
    stackAware: false,
    json: false,
    noFail: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--base":
        args.base = requireValue(arg, argv[++i]);
        break;
      case "--head":
        args.head = requireValue(arg, argv[++i]);
        break;
      case "--staged":
        args.staged = true;
        break;
      case "--pr": {
        const value = requireValue(arg, argv[++i]);
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number <= 0) {
          throw new Error(`--pr requires a positive safe integer (got "${value}")`);
        }
        args.pr = number;
        break;
      }
      case "--repo":
        args.repo = requireValue(arg, argv[++i]);
        break;
      case "--post":
        args.post = true;
        break;
      case "--save-review":
        args.saveReview = true;
        break;
      case "--agents":
        args.agents = requireValue(arg, argv[++i])
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case "--route":
        args.route = true;
        break;
      case "--scope":
        args.scope = requireValue(arg, argv[++i]);
        break;
      case "--config-dir":
        args.configDir = requireValue(arg, argv[++i]);
        break;
      case "--context-file":
        args.contextFile = requireValue(arg, argv[++i]);
        break;
      case "--stack-aware":
        args.stackAware = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--no-fail":
        args.noFail = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function reviewCommand(argv: string[]): Promise<void> {
  let args: ReviewArgs;
  try {
    args = parseReviewArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    validateReviewArgs(args);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // The OpenCode server roots at process.cwd(); run from the repo root so agents
  // can read the whole checkout and diff paths resolve correctly.
  const root = await repoRoot();
  if (root && root !== process.cwd()) {
    process.chdir(root);
  }

  // @ref LLP 0007#ecr-review-local-trust-and-flag-rules [implements] — --context-file is orthogonal enrichment; local read errors fail loud (exit 2)
  // Read the context file ONCE, in the command layer (routed review calls runReview
  // per scope; reading inside would re-read the file N times). Local runs FAIL LOUD
  // on a read error: the user typed the path, so a typo or oversized file is a
  // mistake to surface, not to silently skip (unlike `ecr ci`, which warns and
  // continues to keep the never-fail-checks invariant).
  let contextText: string | undefined;
  if (args.contextFile) {
    try {
      contextText = await readContextFile(args.contextFile);
    } catch (error) {
      process.stderr.write(`--context-file: ${errorMessage(error)}\n`);
      process.exitCode = 2;
      return;
    }
    // Empty/whitespace-only file: warn (a typo'd or unwritten path) but do not fail
    // — there is simply no context to add.
    if (!contextText.trim()) {
      process.stderr.write(`--context-file: ${args.contextFile} is empty; no context added.\n`);
      contextText = undefined;
    }
  }

  try {
    const cwd = process.cwd();
    const makeSource = (): ReviewSource =>
      args.pr != null
        ? new GitHubPRSource({ prNumber: args.pr, repo: args.repo, cwd })
        : new LocalGitSource({ base: args.base, head: args.head, staged: args.staged, cwd });

    // --scope: load the named scope's config and review only that scope's files.
    if (args.scope) {
      // --scope and --config-dir are mutually exclusive (validateArgs), so
      // args.configDir is undefined here; pass it through for consistency and so
      // the manifest always resolves from the same dir as the root config.
      const manifest = await loadRoutingManifest(cwd, { configDir: args.configDir });
      if (!manifest) {
        throw new Error("no .expo-code-review/routing.jsonc — --scope requires a routing manifest");
      }
      const scopeDef = manifest.scopes.find((scope) => scope.name === args.scope);
      if (!scopeDef) {
        throw new Error(
          `unknown scope "${args.scope}". Known scopes: ${manifest.scopes.map((s) => s.name).join(", ")}`,
        );
      }
      const rootConfig = await loadReviewConfig(cwd);
      const config = await loadScopeConfig(cwd, scopeDef, manifest, rootConfig);
      const source = memoizeSource(makeSource());
      try {
        const changed = await source.getChangedFiles();
        const resolution = resolveScopes(
          manifest,
          changed.map((file) => file.path),
        );
        const files = resolution.active.find((scope) => scope.name === args.scope)?.files ?? [];
        if (files.length === 0) {
          process.stdout.write(`No changed files in scope ${args.scope}.\n`);
          return;
        }
        // Build the PR reporter up front when posting, so adjudicate mode can judge the
        // replies against the source before the result is rendered (see the non-scope
        // path). A scope always posts under the DERIVED marker `<rootTag>:<scope>` —
        // from the ROOT config's tag exactly like `ecr ci` does (runRoutedCi prefers
        // rootConfig.commentTag over manifest defaults when they diverge) — so a
        // standalone scope post and CI's per-scope post/clear/reconcile paths always
        // target the same marker, and the bare aggregate marker is never used here.
        // (Per-scope commentTag overrides are rejected by the scope schema for exactly
        // this reason.)
        // @ref LLP 0007#ecr-review-local-trust-and-flag-rules [constrained-by] — must match ci.ts's derivation; the scope schema ban on commentTag is what keeps them aligned
        const { repo: postRepo, error: postRepoError } = await resolvePostRepo(args, cwd);
        const reporter =
          postRepo != null && args.pr != null
            ? new GitHubReporter({
                prNumber: args.pr,
                repo: postRepo,
                commentTag: scopedCommentTag(rootConfig.commentTag, args.scope),
                breakGlassMarker: config.breakGlassMarker,
                cwd,
                // Root-only feedback config (loadScopeConfig inherits it from the root).
                feedback: config.feedback,
                // Root-only too (loadScopeConfig inherits it from the root).
                inline: config.inline,
                headSha: await reviewedHeadSha(source),
              })
            : null;
        const review = await runReview(source, {
          config,
          mode: "local",
          agents: args.agents,
          route: args.route,
          includePaths: files,
          contextText,
          // Explicit --stack-aware only: local config is not a trusted base, so the
          // user typing the flag is the trust principal. Bounds come from the root
          // config; validateArgs already rejected --stack-aware without --pr, and the
          // pr guard here keeps that invariant local.
          stack:
            args.stackAware && args.pr != null ? stackWalkFromConfig(rootConfig.stack) : undefined,
          stackConfirm:
            args.stackAware && args.pr != null
              ? stackConfirmFromConfig(rootConfig.stack)
              : undefined,
          feedback:
            reporter && feedbackNeedsRunSeam(config.feedback)
              ? { config: config.feedback, match: (r) => reporter.matchAdjudicationItems(r) }
              : undefined,
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
        await new TerminalReporter({ json: args.json, noFail: args.noFail }).report(review);

        if (args.pr != null && args.post) {
          if (reporter) {
            // Respect the author's break-glass opt-out, same as the non-scope path.
            let breakGlass = false;
            try {
              breakGlass = await reporter.checkBreakGlass();
            } catch {
              breakGlass = false;
            }
            if (breakGlass) {
              process.stderr.write(
                `\nNot posting: ${config.breakGlassMarker} is set on ${postRepo}#${args.pr} (break-glass).\n`,
              );
            } else {
              await reporter.report(review, review.feedback);
              process.stderr.write(
                `\nPosted scope "${args.scope}" review to ${postRepo}#${args.pr}.\n`,
              );
            }
          } else {
            // @ref LLP 0007#ecr-review-local-trust-and-flag-rules [implements] — a
            // `gh` failure resolving the repo must not hide the review already
            // printed above; only the post step fails here, with a clear message.
            process.stderr.write(
              `\nNot posted: could not resolve the repo for --post (${errorMessage(postRepoError)}). Pass --repo owner/repo.\n`,
            );
            process.exitCode = 2;
          }
        }
      } finally {
        await source.dispose();
      }
      return;
    }

    const config = await loadReviewConfig(cwd, { configDir: args.configDir });
    const source = makeSource();

    // Build the PR reporter up front when posting OR saving a postable preview, so
    // adjudicate mode can judge the
    // PR's replies against the source before the result is rendered. Feedback only
    // has replies to match when reviewing a PR and posting (the terminal preview never
    // renders annotations), so it is wired only when a later/current post is possible.
    const { repo: postRepo, error: postRepoError } = await resolvePostRepo(
      { ...args, post: args.post || args.saveReview },
      cwd,
    );
    const headSha = postRepo != null && args.pr != null ? await reviewedHeadSha(source) : undefined;
    const reporter =
      postRepo != null && args.pr != null
        ? new GitHubReporter({
            prNumber: args.pr,
            repo: postRepo,
            commentTag: config.commentTag,
            breakGlassMarker: config.breakGlassMarker,
            cwd,
            feedback: config.feedback,
            inline: config.inline,
            headSha,
          })
        : null;

    const review = await runReview(source, {
      config,
      mode: "local",
      agents: args.agents,
      route: args.route,
      contextText,
      // Explicit --stack-aware only (see the scope branch); validateArgs already
      // rejected --stack-aware without --pr.
      stack: args.stackAware && args.pr != null ? stackWalkFromConfig(config.stack) : undefined,
      stackConfirm:
        args.stackAware && args.pr != null ? stackConfirmFromConfig(config.stack) : undefined,
      feedback:
        reporter && feedbackNeedsRunSeam(config.feedback)
          ? { config: config.feedback, match: (r) => reporter.matchAdjudicationItems(r) }
          : undefined,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });

    // Always print the result here first.
    await new TerminalReporter({ json: args.json, noFail: args.noFail }).report(review);

    if (args.saveReview) {
      if (postRepo == null || args.pr == null || !isCommitOid(headSha)) {
        throw new Error(
          `could not save a postable review: ${postRepoError ? errorMessage(postRepoError) : "the PR head commit could not be resolved"}`,
        );
      }
      const artifactPath = await writeDeferredReviewArtifact(config, {
        repo: postRepo,
        pr: args.pr,
        headSha,
        review,
        feedback: review.feedback,
      });
      process.stderr.write(`\nSaved postable review artifact: ${artifactPath}\n`);
    }

    // Then, only if asked, publish the same result to the PR.
    if (args.pr != null && args.post) {
      if (reporter) {
        // Respect the author's break-glass opt-out, same as the CI path.
        let breakGlass = false;
        try {
          breakGlass = await reporter.checkBreakGlass();
        } catch {
          breakGlass = false;
        }
        if (breakGlass) {
          process.stderr.write(
            `\nNot posting: ${config.breakGlassMarker} is set on ${postRepo}#${args.pr} (break-glass).\n`,
          );
        } else {
          await reporter.report(review, review.feedback);
          process.stderr.write(`\nPosted review to ${postRepo}#${args.pr}.\n`);
        }
      } else {
        // @ref LLP 0007#ecr-review-local-trust-and-flag-rules [implements] — a `gh`
        // failure resolving the repo (no auth, no network, no GitHub remote, rate
        // limit) must not hide the review already printed above; only the post
        // step fails here, with a clear message.
        process.stderr.write(
          `\nNot posted: could not resolve the repo for --post (${errorMessage(postRepoError)}). Pass --repo owner/repo.\n`,
        );
        process.exitCode = 2;
      }
    }
  } catch (error) {
    process.stderr.write(`AI review failed: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

/**
 * The head commit the review reads, when the source can pin one (a GitHub PR). The
 * reporter binds every adjudication verdict to it, so a stored verdict carries to a
 * later run only while the reviewed source is unchanged (see mergeFeedback). Never
 * throws: an unresolvable head reads as unknown source, which re-judges the reply
 * instead of trusting a verdict about code we cannot pin.
 */
async function reviewedHeadSha(source: ReviewSource): Promise<string | undefined> {
  try {
    return (await source.getMetadata()).headOid;
  } catch {
    return undefined;
  }
}

export interface PostRepoResolution {
  repo?: string;
  error?: unknown;
}

// @ref LLP 0007#ecr-review-local-trust-and-flag-rules [implements] — local runs
// still print the review even when --post's repo can't be resolved
/**
 * Resolve the repo needed for --post --pr, without ever throwing: a `gh` failure
 * (no auth, no network, no GitHub remote, rate limit) must degrade to "skip the
 * post step", not abort the review itself — the local run already trusts the
 * caller and should still show them the review. Callers treat a returned `error`
 * as "no repo, and here's why" once they reach the post step; the review and its
 * optional feedback seam simply run without a reporter until then.
 *
 * `resolve` is injectable (defaults to the real `resolveRepo`) purely so tests can
 * exercise the failure path deterministically, without a `gh` binary or network.
 */
export async function resolvePostRepo(
  args: Pick<ReviewArgs, "post" | "pr" | "repo">,
  cwd: string,
  resolve: (cwd: string) => Promise<string> = resolveRepo,
): Promise<PostRepoResolution> {
  if (!(args.post && args.pr != null)) {
    return {};
  }
  if (args.repo) {
    return { repo: args.repo };
  }
  try {
    return { repo: await resolve(cwd) };
  } catch (error) {
    return { error };
  }
}

// @ref LLP 0007#ecr-review-local-trust-and-flag-rules [implements] — mutually exclusive flags rejected outright, never silently ignored
/** Reject flag combinations that don't make sense together. */
export function validateReviewArgs(args: ReviewArgs): void {
  if (args.pr != null && (args.base || args.head || args.staged)) {
    throw new Error(
      "--pr reviews a PR by its diff and cannot be combined with --base/--head/--staged.",
    );
  }
  if (args.pr == null && (args.repo || args.post || args.saveReview)) {
    throw new Error("--repo/--post/--save-review only apply together with --pr.");
  }
  if (args.saveReview && !args.repo) {
    throw new Error("--save-review requires explicit --repo owner/repo.");
  }
  if (args.saveReview && args.post) {
    throw new Error("--save-review and --post are mutually exclusive.");
  }
  if (args.saveReview && (args.scope || args.configDir)) {
    throw new Error("--save-review does not support --scope or --config-dir.");
  }
  // Same rule as --repo/--post: the stack walk needs a PR to walk from, so a bare
  // --stack-aware would be silently ignored — reject it instead.
  if (args.pr == null && args.stackAware) {
    throw new Error("--stack-aware only applies together with --pr.");
  }
  // --staged diffs the index against HEAD, so --base/--head have no effect. Reject
  // the combination rather than silently ignoring the range the user asked for.
  if (args.staged && (args.base || args.head)) {
    throw new Error(
      "--staged reviews the staged changes (index vs HEAD) and cannot be combined with --base/--head.",
    );
  }
  if (args.scope && args.configDir) {
    throw new Error("--scope and --config-dir are mutually exclusive.");
  }
}

/** Resolve owner/repo from the current checkout via gh (for --post). */
