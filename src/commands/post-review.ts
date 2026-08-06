// @ref LLP 0007#deferred-review-posting [implements] — no-model post of an exact, target-bound preview artifact
import path from "node:path";

import { loadReviewConfig } from "../config/load.js";
import {
  assertDeferredReviewCurrent,
  readDeferredReviewArtifact,
  reviewPostingConfigFingerprint,
  type DeferredReviewArtifact,
} from "../core/deferred-review.js";
import { repoRoot } from "../core/exec.js";
import { errorMessage } from "../core/util.js";
import { GitHubReporter } from "../reporters/github.js";
import { GitHubPRSource, isCommitOid } from "../sources/github-pr.js";

const USAGE = `ecr post-review — post an exact saved PR review without re-running models

Usage:
  ecr post-review --artifact <path> --repo <owner/repo> --pr <n>

The artifact must come from \`ecr review --save-review --repo <owner/repo> --pr <n>\`.
Before writing to GitHub, this command verifies the explicit repo/PR, the live PR
head commit, the local posting policy, and the PR's break-glass marker.
`;

export interface PostReviewArgs {
  artifact?: string;
  repo?: string;
  pr?: number;
  help: boolean;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePostReviewArgs(argv: string[]): PostReviewArgs {
  const args: PostReviewArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--artifact":
        args.artifact = requireValue(arg, argv[++i]);
        break;
      case "--repo":
        args.repo = requireValue(arg, argv[++i]);
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

function validatePostReviewArgs(
  args: PostReviewArgs,
): asserts args is PostReviewArgs & { artifact: string; repo: string; pr: number } {
  if (!args.artifact || !args.repo || args.pr == null) {
    throw new Error("--artifact, --repo, and --pr are all required");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error(`--repo requires owner/repo (got "${args.repo}")`);
  }
}

interface DeferredReviewPoster {
  checkBreakGlass(): Promise<boolean>;
  report(
    review: DeferredReviewArtifact["review"],
    feedback?: DeferredReviewArtifact["feedback"],
  ): Promise<void>;
}

/** Break-glass errors fail closed: no report call occurs unless the check says false. */
export async function publishDeferredReview(
  poster: DeferredReviewPoster,
  artifact: DeferredReviewArtifact,
  assertReadyToPost: () => Promise<void> = async () => {},
): Promise<"posted" | "break-glass"> {
  if (await poster.checkBreakGlass()) {
    return "break-glass";
  }
  await assertReadyToPost();
  await poster.report(artifact.review, artifact.feedback);
  return "posted";
}

export async function postReviewCommand(argv: string[]): Promise<void> {
  let args: PostReviewArgs;
  try {
    args = parsePostReviewArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return;
    }
    validatePostReviewArgs(args);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // Resolve before chdir so a relative artifact path keeps the caller's meaning.
  const artifactPath = path.resolve(process.cwd(), args.artifact);
  try {
    const root = await repoRoot();
    if (root && root !== process.cwd()) {
      process.chdir(root);
    }
    const cwd = process.cwd();
    const [artifact, config] = await Promise.all([
      readDeferredReviewArtifact(artifactPath),
      loadReviewConfig(cwd),
    ]);
    const source = new GitHubPRSource({ prNumber: args.pr, repo: args.repo, cwd });
    const headSha = (await source.getMetadata()).headOid;
    if (!isCommitOid(headSha)) {
      throw new Error(`could not resolve a full head commit for ${args.repo}#${args.pr}`);
    }
    assertDeferredReviewCurrent(artifact, {
      repo: args.repo,
      pr: args.pr,
      headSha,
      configFingerprint: reviewPostingConfigFingerprint(config),
    });

    const reporter = new GitHubReporter({
      prNumber: args.pr,
      repo: args.repo,
      commentTag: config.commentTag,
      breakGlassMarker: config.breakGlassMarker,
      cwd,
      feedback: config.feedback,
      headSha,
    });
    const result = await publishDeferredReview(reporter, artifact, async () => {
      // Re-fetch rather than reusing GitHubPRSource's memoized metadata, and reload
      // config after the break-glass API call. This narrows the unavoidable remote
      // TOCTOU window and prevents a head/policy change during setup from reaching
      // the reporter.
      const [latestMetadata, latestConfig] = await Promise.all([
        new GitHubPRSource({ prNumber: args.pr, repo: args.repo, cwd }).getMetadata(),
        loadReviewConfig(cwd),
      ]);
      if (!isCommitOid(latestMetadata.headOid)) {
        throw new Error(`could not re-resolve a full head commit for ${args.repo}#${args.pr}`);
      }
      assertDeferredReviewCurrent(artifact, {
        repo: args.repo,
        pr: args.pr,
        headSha: latestMetadata.headOid,
        configFingerprint: reviewPostingConfigFingerprint(latestConfig),
      });
    });
    if (result === "break-glass") {
      process.stderr.write(
        `Not posting: ${config.breakGlassMarker} is set on ${args.repo}#${args.pr}.\n`,
      );
      return;
    }
    process.stderr.write(`Posted saved review to ${args.repo}#${args.pr}.\n`);
  } catch (error) {
    process.stderr.write(`Saved review was not posted: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
