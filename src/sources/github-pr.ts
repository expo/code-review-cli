import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../core/exec.js";
import { parseUnifiedDiff } from "../core/diff.js";
import { scrubAmbientRuntimeConfig } from "../core/scrub.js";
import type { DiffEntry, ReviewMetadata } from "../core/schema.js";
import type { PreparedReadRoot, ReviewSource } from "./source.js";

export interface GitHubPRSourceOptions {
  prNumber: number;
  /** owner/repo. Optional; gh infers it from the checkout when omitted. */
  repo?: string;
  cwd?: string;
}

/** A full 40-hex-char commit OID — the only ref form passed to security-sensitive git calls. */
export function isCommitOid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Append gh as a git credential helper for a single command. The token comes from
 * GH_TOKEN via the credential-helper protocol — never argv, never `.git/config` —
 * so a base-SHA checkout with `persist-credentials: false` (no extraheader) can
 * still fetch a private repo. Appending (not replacing) keeps a local user's own
 * helpers first, so developer machines behave exactly as before.
 */
const GH_CREDENTIAL_HELPER_ARGS = ["-c", "credential.helper=!gh auth git-credential"];

/**
 * Pulls PR diff + metadata through the `gh` CLI, which is preinstalled and
 * authenticated on GitHub Actions runners via GH_TOKEN.
 */
export class GitHubPRSource implements ReviewSource {
  constructor(private readonly options: GitHubPRSourceOptions) {}

  private metadataPromise: Promise<ReviewMetadata> | undefined;

  private repoArgs(): string[] {
    return this.options.repo ? ["--repo", this.options.repo] : [];
  }

  /**
   * Memoized internally (not just by memoizeSource) because the materialization
   * paths below need the immutable OIDs and must not depend on the caller having
   * called getMetadata() first.
   */
  getMetadata(): Promise<ReviewMetadata> {
    return (this.metadataPromise ??= this.fetchMetadata());
  }

  private async fetchMetadata(): Promise<ReviewMetadata> {
    const { stdout } = await run(
      "gh",
      [
        "pr",
        "view",
        String(this.options.prNumber),
        ...this.repoArgs(),
        "--json",
        // baseRefOid/headRefOid are the immutable commit OIDs backing this PR at
        // this moment; every materialization below pins to them so a rename,
        // force-push, or deleted head between API calls can't swap a tree.
        "title,body,baseRefName,headRefName,baseRefOid,headRefOid",
      ],
      { cwd: this.options.cwd },
    );
    const parsed = JSON.parse(stdout) as {
      title?: string;
      body?: string;
      baseRefName?: string;
      headRefName?: string;
      baseRefOid?: string;
      headRefOid?: string;
    };
    return {
      title: parsed.title ?? "",
      body: parsed.body ?? "",
      baseRef: parsed.baseRefName ?? "",
      headRef: parsed.headRefName ?? "",
      baseOid: isCommitOid(parsed.baseRefOid) ? parsed.baseRefOid.toLowerCase() : undefined,
      headOid: isCommitOid(parsed.headRefOid) ? parsed.headRefOid.toLowerCase() : undefined,
    };
  }

  async getChangedFiles(): Promise<DiffEntry[]> {
    const { stdout } = await run(
      "gh",
      ["pr", "diff", String(this.options.prNumber), ...this.repoArgs()],
      { cwd: this.options.cwd },
    );
    return parseUnifiedDiff(stdout);
  }

  /**
   * Fetch `ref` from the repo's own HTTPS URL and materialize `oid` as a detached
   * throwaway worktree under a fresh temp dir. Never falls back to a branch name:
   * `oid` is validated as a full commit hash before reaching git.
   */
  private async materializeWorktreeAsync(ref: string, oid: string): Promise<PreparedReadRoot> {
    if (!this.options.repo) {
      throw new Error("cannot materialize a PR tree without an explicit owner/repo");
    }
    if (!isCommitOid(oid)) {
      throw new Error(`refusing to materialize a non-OID ref: "${oid}"`);
    }
    const cwd = this.options.cwd;
    const url = `https://github.com/${this.options.repo}.git`;
    let parent: string | undefined;
    try {
      await run(
        "git",
        [...GH_CREDENTIAL_HELPER_ARGS, "fetch", "--no-tags", "--depth=1", url, ref],
        { cwd },
      );
      parent = await mkdtemp(path.join(tmpdir(), "ecr-tree-"));
      const dir = path.join(parent, "tree"); // must not pre-exist for `worktree add`
      // Check out the OID (not FETCH_HEAD): if the ref moved between the API call
      // and this fetch, the OID is absent and this fails instead of silently
      // materializing a different tree than the one the diff was fetched for.
      await run("git", ["worktree", "add", "--detach", dir, oid], { cwd });
      const removeParent = parent;
      return {
        dir,
        cleanup: async () => {
          try {
            await run("git", ["worktree", "remove", "--force", dir], { cwd });
          } catch {
            // best effort — fall through to removing the temp dir
          }
          await rm(removeParent, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (parent) {
        await rm(parent, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Check the PR HEAD out into a throwaway worktree so the agents and verifier
   * read the PR's versions of files (not whatever branch happens to be checked
   * out), pinned to the immutable head OID. The fetch uses `refs/pull/<n>/head`,
   * which the base repo hosts even for fork PRs.
   *
   * The worktree is SCRUBBED of ambient runtime config (opencode.json, .opencode
   * plugins, AGENTS.md/CLAUDE.md, .mcp.json, .env*, …) before it's returned: the
   * OpenCode server is started with this directory as its project root, and
   * anything it discovers there is attacker-controlled PR content executing or
   * injecting inside a process that holds the model credential and GH_TOKEN.
   *
   * Returns null only when no owner/repo is configured (a local `--pr` run
   * without --repo, where the current checkout is an acceptable read root).
   * Materialization FAILURES throw — the caller decides per mode whether that is
   * fatal (CI: fail closed) or a soft fallback (local: the user's own checkout).
   */
  async prepareReadRootAsync(): Promise<PreparedReadRoot | null> {
    if (!this.options.repo) {
      // Without an explicit owner/repo we can't build the fetch URL safely.
      return null;
    }
    const metadata = await this.getMetadata();
    if (!isCommitOid(metadata.headOid)) {
      throw new Error("GitHub did not report an immutable head OID for this PR");
    }
    const root = await this.materializeWorktreeAsync(
      `refs/pull/${this.options.prNumber}/head`,
      metadata.headOid,
    );
    try {
      await scrubAmbientRuntimeConfig(root.dir);
    } catch (error) {
      // A half-scrubbed tree must never become the runtime's project root.
      await root.cleanup().catch(() => {});
      throw error;
    }
    return root;
  }

  /**
   * Materialize the PR's BASE commit as the trusted configuration root: review
   * policy, prompts, routing, and auth mapping load from here, so a PR cannot
   * change the reviewer that evaluates it (config changes activate on merge).
   * Failures throw — `ecr ci` must fail closed, never fall back to the checkout.
   */
  async prepareTrustedConfigRootAsync(): Promise<PreparedReadRoot> {
    const metadata = await this.getMetadata();
    if (!isCommitOid(metadata.baseOid)) {
      throw new Error("GitHub did not report an immutable base OID for this PR");
    }
    // The base OID is fetchable by SHA (it's the tip of the base branch as of the
    // API call; GitHub serves reachable SHAs — the same mechanism actions/checkout
    // uses for `ref:` pins).
    return this.materializeWorktreeAsync(metadata.baseOid, metadata.baseOid);
  }
}
