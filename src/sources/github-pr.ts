// @ref LLP 0008#pr-head-materialization — PR HEAD is materialized as a detached worktree pinned to the immutable head OID, never a branch/ref name
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveTrustedTool, run } from "../core/exec.js";
import { parseUnifiedDiff } from "../core/diff.js";
import { removeEscapingSymlinks, scrubAmbientRuntimeConfig } from "../core/scrub.js";
import type { DiffEntry, ReviewMetadata } from "../core/schema.js";
import type { PreparedReadRoot, ReviewSource, StackManifest, StackWalkOptions } from "./source.js";

export interface GitHubPRSourceOptions {
  prNumber: number;
  /** owner/repo. Optional; gh infers it from the checkout when omitted. */
  repo?: string;
  cwd?: string;
}

/** A full 40-hex-char commit OID — the only ref form passed to security-sensitive git calls. */
// @ref LLP 0008#pr-head-materialization [constrained-by] — the single gate: only a full 40-hex OID reaches git worktree add/fetch, closing the TOCTOU race and blocking ref/argument injection at once
export function isCommitOid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/** One open child PR as returned by the pulls-list endpoint, pre-parsed. */
export interface StackChildPr {
  number: number;
  title: string;
  authorLogin: string;
  /** The child's own head branch — the base we recurse on to find ITS children. */
  headRef: string;
  /** head.repo.full_name === "owner/repo": a fork PR fails this and is dropped. */
  sameRepo: boolean;
}

/** A child PR's file list plus whether it was capped at maxFilesPerPr. */
export interface StackChildFiles {
  files: string[];
  truncated: boolean;
}

// @ref LLP 0010#bounded-guarded-upward-walk [implements] — every guard (same-repo, same-author, depth/width caps, cycle guard, fail-open) lives here as pure logic; the IO is injected so it is unit-testable without gh
/**
 * The bounded, guarded upward walk, factored pure over injected fetchers so it can be
 * tested without gh. Level-by-level (BFS over head branches), it keeps only same-repo
 * (and, when required, same-author) children, caps children per level at `maxPrs`,
 * stops at `maxDepth`, and guards against branch cycles. ANY fetch error → `null`
 * (fail-open); an empty result → `null` (nothing to inject).
 */
export async function walkUpstack(
  rootHeadRef: string,
  rootAuthor: string,
  options: StackWalkOptions,
  fetchChildren: (baseBranch: string) => Promise<StackChildPr[]>,
  fetchFiles: (prNumber: number) => Promise<StackChildFiles>,
): Promise<StackManifest | null> {
  const upstackPRs: StackManifest["upstackPRs"] = [];
  let truncated = false;
  const visited = new Set<string>([rootHeadRef]);
  let frontier = [rootHeadRef];
  try {
    for (let depth = 0; depth < options.maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      // maxPrs is a PER-LEVEL budget shared by every parent in the frontier, not a
      // per-parent one — otherwise a branching (diamond) stack would widen each level
      // to frontier.length × maxPrs and compound across depths, blowing the documented
      // hard bound on walked PRs and gh calls.
      let levelBudget = options.maxPrs;
      for (const baseBranch of frontier) {
        if (levelBudget <= 0) {
          break;
        }
        const children = await fetchChildren(baseBranch);
        const eligible = children
          .filter((child) => child.sameRepo)
          .filter((child) => !options.requireSameAuthor || child.authorLogin === rootAuthor)
          .filter((child) => !visited.has(child.headRef))
          .slice(0, levelBudget);
        levelBudget -= eligible.length;
        for (const child of eligible) {
          visited.add(child.headRef);
          const { files, truncated: capped } = await fetchFiles(child.number);
          truncated = truncated || capped;
          upstackPRs.push({
            number: child.number,
            title: child.title,
            authorLogin: child.authorLogin,
            files,
          });
          next.push(child.headRef);
        }
      }
      frontier = next;
    }
  } catch {
    return null;
  }
  return upstackPRs.length > 0 ? { upstackPRs, truncated } : null;
}

/**
 * Parse the NDJSON `{filename}` lines from the child-PR files endpoint into a clean
 * path list. Any name carrying a control character (a git path may legally contain
 * a newline) is dropped outright: split on raw lines it would have forged an extra
 * manifest entry, and no legitimate reviewable path needs control characters. A
 * malformed line throws — the walk's fail-open catch turns that into "no manifest".
 * Exported for tests.
 */
export function parseChildFileNdjson(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { filename?: string }).filename ?? "")
    .filter((name) => name.length > 0 && ![...name].some((char) => char.charCodeAt(0) < 0x20));
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
    const gh = await resolveTrustedTool("gh");
    const { stdout } = await run(
      gh,
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
    const gh = await resolveTrustedTool("gh");
    const { stdout } = await run(
      gh,
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
    const gitPath = await resolveTrustedTool("git");
    let parent: string | undefined;
    try {
      await run(
        gitPath,
        [...GH_CREDENTIAL_HELPER_ARGS, "fetch", "--no-tags", "--depth=1", url, ref],
        { cwd },
      );
      parent = await mkdtemp(path.join(tmpdir(), "ecr-tree-"));
      const dir = path.join(parent, "tree"); // must not pre-exist for `worktree add`
      // Check out the OID (not FETCH_HEAD): if the ref moved between the API call
      // and this fetch, the OID is absent and this fails instead of silently
      // materializing a different tree than the one the diff was fetched for.
      await run(gitPath, ["worktree", "add", "--detach", dir, oid], { cwd });
      const removeParent = parent;
      return {
        dir,
        cleanup: async () => {
          try {
            await run(gitPath, ["worktree", "remove", "--force", dir], { cwd });
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
   * Out-of-tree symlinks are stripped in the same pass: read tools are scoped by
   * the literal path argument but follow symlinks underneath, so a PR-committed
   * link escaping the tree would otherwise read arbitrary host files.
   *
   * Returns null only when no owner/repo is configured (a local `--pr` run
   * without --repo, where the current checkout is an acceptable read root).
   * Materialization FAILURES throw — the caller decides per mode whether that is
   * fatal (CI: fail closed) or a soft fallback (local: the user's own checkout).
   */
  // @ref LLP 0008#pr-head-materialization [implements] — a half-scrubbed tree must never be returned; a scrub failure tears down the worktree and rethrows instead of handing back a partial scrub
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
      await removeEscapingSymlinks(root.dir);
    } catch (error) {
      // A half-scrubbed tree must never become the runtime's project root.
      await root.cleanup().catch(() => {});
      throw error;
    }
    return root;
  }

  // @ref LLP 0010#bounded-guarded-upward-walk [constrained-by] — the whole method is wrapped fail-open: no gh/parse error ever escapes as a throw, so a broken walk can never fail a check or block a finding
  /**
   * Walk the OPEN PRs stacked on top of this one and return a paths-only manifest.
   * Fails open to `null` on ANY error (no repo, gh failure, rate limit, parse error,
   * empty stack), so the review is exactly as if the feature were off.
   */
  async getStackContextAsync(options: StackWalkOptions): Promise<StackManifest | null> {
    const repo = this.options.repo;
    if (!repo) {
      // Without an explicit owner/repo we can't query the pulls list safely.
      return null;
    }
    try {
      const gh = await resolveTrustedTool("gh");
      const [metadata, anchors] = await Promise.all([
        this.getMetadata(),
        this.fetchPrTrustAnchors(gh, repo),
      ]);
      if (!metadata.headRef || !anchors.author) {
        return null;
      }
      // A fork PR's headRefName is a branch of the FORK, not of the base repo. Using
      // it as the pulls-list `base=` filter would match a same-named BASE-repo branch
      // (a fork head called "main" would pull in every open PR targeting main), so
      // unrelated PRs would enter the manifest. A cross-repo head has no base-repo
      // branch to walk — there is no stack.
      if (anchors.crossRepo) {
        return null;
      }
      return await walkUpstack(
        metadata.headRef,
        anchors.author,
        options,
        (baseBranch) => this.fetchOpenChildren(gh, repo, baseBranch),
        (prNumber) => this.fetchChildFiles(gh, repo, prNumber, options.maxFilesPerPr),
      );
    } catch {
      return null;
    }
  }

  /**
   * The current PR's author login (the same-author gate's trust anchor) and whether
   * its head lives in another repository (a fork — see the cross-repo guard above).
   */
  private async fetchPrTrustAnchors(
    gh: string,
    repo: string,
  ): Promise<{ author: string | null; crossRepo: boolean }> {
    const { stdout } = await run(
      gh,
      [
        "pr",
        "view",
        String(this.options.prNumber),
        "--repo",
        repo,
        "--json",
        "author,isCrossRepository",
      ],
      { cwd: this.options.cwd },
    );
    const raw = JSON.parse(stdout) as { author?: { login?: string }; isCrossRepository?: boolean };
    const author = raw.author?.login?.trim();
    return { author: author || null, crossRepo: raw.isCrossRepository === true };
  }

  /** Open PRs whose base branch is `baseBranch` (this PR's head, or a child's head). */
  private async fetchOpenChildren(
    gh: string,
    repo: string,
    baseBranch: string,
  ): Promise<StackChildPr[]> {
    // --method GET is mandatory (else gh POSTs); --paginate + a per-element --jq
    // yields NDJSON that stays valid when gh concatenates pages.
    const { stdout } = await run(
      gh,
      [
        "api",
        "--method",
        "GET",
        `repos/${repo}/pulls`,
        "-f",
        "state=open",
        "-f",
        `base=${baseBranch}`,
        // Safety cap on pagination (100/page), same convention as fetchAllComments:
        // fewer round-trips per level of the walk.
        "-f",
        "per_page=100",
        "--paginate",
        "--jq",
        ".[] | {number, title, authorLogin: .user.login, headRef: .head.ref, headRepoFullName: .head.repo.full_name}",
      ],
      { cwd: this.options.cwd },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const raw = JSON.parse(line) as {
          number: number;
          title?: string;
          authorLogin?: string;
          headRef?: string;
          headRepoFullName?: string;
        };
        return {
          number: raw.number,
          title: raw.title ?? "",
          authorLogin: raw.authorLogin ?? "",
          headRef: raw.headRef ?? "",
          sameRepo: raw.headRepoFullName === repo,
        };
      });
  }

  /** A child PR's changed paths, capped at `maxFiles` with a truncated marker. */
  private async fetchChildFiles(
    gh: string,
    repo: string,
    prNumber: number,
    maxFiles: number,
  ): Promise<StackChildFiles> {
    const { stdout } = await run(
      gh,
      [
        "api",
        // --method GET is mandatory once a -f field is present (else gh POSTs).
        "--method",
        "GET",
        `repos/${repo}/pulls/${prNumber}/files`,
        // 100/page (fetchAllComments convention): a 3000-file child PR is ~30
        // round-trips instead of ~100 at the REST default of 30/page.
        "-f",
        "per_page=100",
        "--paginate",
        "--jq",
        // Objects, NOT raw strings (.[].filename): gh prints a raw string result
        // one value per line, so a git path containing a newline would split into
        // TWO manifest entries — one of them a forged membership the grounding
        // check would then accept. NDJSON keeps the newline escaped.
        ".[] | {filename}",
      ],
      { cwd: this.options.cwd },
    );
    const all = parseChildFileNdjson(stdout);
    return { files: all.slice(0, maxFiles), truncated: all.length > maxFiles };
  }

  /**
   * Materialize the PR's BASE commit as the trusted configuration root: review
   * policy, prompts, routing, and auth mapping load from here, so a PR cannot
   * change the reviewer that evaluates it (config changes activate on merge).
   * Failures throw — `ecr ci` must fail closed, never fall back to the checkout.
   */
  // @ref LLP 0008#the-trusted-base-root [implements] — materializes the PR BASE (not HEAD) as a separate, unscrubbed worktree; a PR cannot change the reviewer that evaluates it
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
