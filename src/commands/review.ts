// @ref LLP 0007#ecr-review-local-trust-and-flag-rules — local runs: the person at the terminal is the trust principal, even with --pr
import { loadReviewConfig, loadScopeConfig } from "../config/load.js";
import { loadRoutingManifest, resolveScopes, scopedCommentTag } from "../config/routing.js";
import { repoRoot, resolveRepo } from "../core/exec.js";
import { errorMessage } from "../core/util.js";
import { runReview } from "../core/review.js";
import { LocalGitSource } from "../sources/local-git.js";
import { GitHubPRSource } from "../sources/github-pr.js";
import type { ReviewSource } from "../sources/source.js";
import { memoizeSource } from "../sources/source.js";
import { TerminalReporter } from "../reporters/terminal.js";
import { GitHubReporter } from "../reporters/github.js";

const USAGE = `ecr review — AI code review, printed to your terminal

Usage:
  ecr review [options]                 review local changes
  ecr review --pr <n> [--post]         review a GitHub PR by number

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
  --agents <a,b>       run only these agents (comma-separated ids); default: all
  --route              let the router pick relevant agents from the diff
  --scope <name>       review only this routing scope (needs a routing.jsonc);
                       runs its config over just that scope's changed files
  --config-dir <dir>   load config from <dir> instead of .expo-code-review/
                       (also ECR_CONFIG_DIR); can't combine with --scope
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

interface ReviewArgs {
  base?: string;
  head?: string;
  staged: boolean;
  pr?: number;
  repo?: string;
  post: boolean;
  agents?: string[];
  route: boolean;
  scope?: string;
  configDir?: string;
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

function parseArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = {
    staged: false,
    post: false,
    route: false,
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
        if (!Number.isInteger(number) || number <= 0) {
          throw new Error(`--pr requires a positive PR number (got "${value}")`);
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
    args = parseArgs(argv);
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
    validateArgs(args);
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
        const review = await runReview(source, {
          config,
          mode: "local",
          agents: args.agents,
          route: args.route,
          includePaths: files,
          onProgress: (message) => process.stderr.write(`${message}\n`),
        });
        await new TerminalReporter({ json: args.json, noFail: args.noFail }).report(review);

        if (args.post && args.pr != null) {
          const repo = args.repo ?? (await resolveRepo(cwd));
          // A scope always posts under the DERIVED marker `<rootTag>:<scope>` —
          // from the ROOT config's tag exactly like `ecr ci` does (runRoutedCi
          // prefers rootConfig.commentTag over manifest defaults when they
          // diverge) — so a standalone scope post and CI's per-scope post/clear/
          // reconcile paths always target the same marker, and the bare aggregate
          // marker is never used here. (Per-scope commentTag overrides are
          // rejected by the scope schema for exactly this reason.)
          // @ref LLP 0007#ecr-review-local-trust-and-flag-rules [constrained-by] — must match ci.ts's derivation; the scope schema ban on commentTag is what keeps them aligned
          const tag = scopedCommentTag(rootConfig.commentTag, args.scope);
          const reporter = new GitHubReporter({
            prNumber: args.pr,
            repo,
            commentTag: tag,
            breakGlassMarker: config.breakGlassMarker,
            cwd,
          });
          // Respect the author's break-glass opt-out, same as the non-scope path.
          let breakGlass = false;
          try {
            breakGlass = await reporter.checkBreakGlass();
          } catch {
            breakGlass = false;
          }
          if (breakGlass) {
            process.stderr.write(
              `\nNot posting: ${config.breakGlassMarker} is set on ${repo}#${args.pr} (break-glass).\n`,
            );
          } else {
            await reporter.report(review);
            process.stderr.write(`\nPosted scope "${args.scope}" review to ${repo}#${args.pr}.\n`);
          }
        }
      } finally {
        await source.dispose();
      }
      return;
    }

    const config = await loadReviewConfig(cwd, { configDir: args.configDir });
    const source = makeSource();

    const review = await runReview(source, {
      config,
      mode: "local",
      agents: args.agents,
      route: args.route,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });

    // Always print the result here first.
    await new TerminalReporter({ json: args.json, noFail: args.noFail }).report(review);

    // Then, only if asked, publish the same result to the PR.
    if (args.post && args.pr != null) {
      const repo = args.repo ?? (await resolveRepo(cwd));
      const reporter = new GitHubReporter({
        prNumber: args.pr,
        repo,
        commentTag: config.commentTag,
        breakGlassMarker: config.breakGlassMarker,
        cwd,
      });
      // Respect the author's break-glass opt-out, same as the CI path.
      let breakGlass = false;
      try {
        breakGlass = await reporter.checkBreakGlass();
      } catch {
        breakGlass = false;
      }
      if (breakGlass) {
        process.stderr.write(
          `\nNot posting: ${config.breakGlassMarker} is set on ${repo}#${args.pr} (break-glass).\n`,
        );
      } else {
        await reporter.report(review);
        process.stderr.write(`\nPosted review to ${repo}#${args.pr}.\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`AI review failed: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

// @ref LLP 0007#ecr-review-local-trust-and-flag-rules [implements] — mutually exclusive flags rejected outright, never silently ignored
/** Reject flag combinations that don't make sense together. */
function validateArgs(args: ReviewArgs): void {
  if (args.pr != null && (args.base || args.head || args.staged)) {
    throw new Error(
      "--pr reviews a PR by its diff and cannot be combined with --base/--head/--staged.",
    );
  }
  if (args.pr == null && (args.repo || args.post)) {
    throw new Error("--repo/--post only apply together with --pr.");
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
