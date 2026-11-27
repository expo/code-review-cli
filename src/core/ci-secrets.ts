// @ref LLP 0007#doctor-and-setup-auth [implements] — the CI seed sends a login made only for CI straight to GitHub Actions secrets; no token is printed or kept
import { resolveTrustedTool, run } from "./exec.js";

/** The secret that holds the refresh token. Only the rotation workflow in the store repo reads it. */
export const CI_REFRESH_SECRET = "XAI_OAUTH_REFRESH_TOKEN";
/** The secret that holds the access token. Review workflows pass it to `ecr`. */
export const CI_ACCESS_SECRET = "XAI_OAUTH_ACCESS_TOKEN";

export interface CiSeedRepos {
  /** Holds the refresh token and runs the rotation workflow. */
  store: string;
  /** Repos that run reviews. Each one gets the access token only. */
  targets: string[];
}

export interface OauthPair {
  access: string;
  refresh: string;
}

export interface SecretWrite {
  name: string;
  repo: string;
  value: string;
}

// The value goes to `gh --repo`, so it must not look like a flag or a path.
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;

export function parseRepoSlug(value: string): string {
  if (!REPO_SLUG.test(value)) {
    throw new Error(`"${value}" is not a repository in <owner>/<repo> form.`);
  }
  return value;
}

/** Both tokens of one provider's oauth entry in an OpenCode auth.json, or null when either is missing. */
export function oauthPairFromStore(
  parsed: Record<string, { type?: string; access?: string; refresh?: string } | undefined>,
  provider: string,
): OauthPair | null {
  const entry = parsed[provider];
  if (entry?.type !== "oauth" || !entry.access || !entry.refresh) {
    return null;
  }
  return { access: entry.access, refresh: entry.refresh };
}

/**
 * The secret writes for one seed, in the order they must run.
 * The refresh token goes first.
 * With it saved, the rotation workflow can repair an access token write that fails after it.
 */
export function ciSecretWrites(pair: OauthPair, repos: CiSeedRepos): SecretWrite[] {
  const accessRepos = [...new Set([repos.store, ...repos.targets])];
  return [
    { name: CI_REFRESH_SECRET, repo: repos.store, value: pair.refresh },
    ...accessRepos.map((repo) => ({ name: CI_ACCESS_SECRET, repo, value: pair.access })),
  ];
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Fail before the login when `gh` cannot reach the Actions secrets of a repo.
 * A login that cannot be saved is wasted.
 */
export async function assertSecretsReachable(repos: string[]): Promise<void> {
  const gh = await resolveTrustedTool("gh");
  for (const repo of new Set(repos)) {
    const result = await run(gh, ["api", `repos/${repo}/actions/secrets/public-key`], {
      check: false,
    });
    if (result.code !== 0) {
      throw new Error(
        `\`gh\` cannot reach the Actions secrets of ${repo} (${firstLine(result.stderr) || "no detail"}). ` +
          `Sign in with \`gh auth login\` as someone who can set secrets there. Nothing was changed.`,
      );
    }
  }
}

/**
 * Write the secrets in order and stop at the first failure.
 * Each value goes to `gh` through stdin, so it is never on a command line or in an error message.
 */
export async function writeSecrets(writes: SecretWrite[]): Promise<void> {
  const gh = await resolveTrustedTool("gh");
  const done: string[] = [];
  for (const write of writes) {
    const result = await run(gh, ["secret", "set", write.name, "--repo", write.repo], {
      input: write.value,
      check: false,
    });
    if (result.code !== 0) {
      throw new Error(
        `could not write ${write.name} to ${write.repo} (${firstLine(result.stderr) || "no detail"}). ` +
          (done.length > 0 ? `Already written: ${done.join(", ")}. ` : "Nothing was written. ") +
          `Run the same command again; it signs in again and writes every secret.`,
      );
    }
    done.push(`${write.name} in ${write.repo}`);
  }
}
