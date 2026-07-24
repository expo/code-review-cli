import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../core/exec.js";
import { parseUnifiedDiff } from "../core/diff.js";
import {
  buildDiffLineIndex,
  commentMarker,
  parseReviewState,
  renderAggregateMarkdown,
  renderMarkdown,
} from "../core/render.js";
import type { LinkContext, ReviewState, ScopeReviewResult } from "../core/render.js";
import { fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type { CoordinatorOutput, DismissalRecord } from "../core/schema.js";
import type { Reporter } from "./reporter.js";

export interface DismissalResult {
  dismissedCount: number;
  matched: string[];
  unmatched: string[];
}

export interface GitHubReporterOptions {
  prNumber: number;
  repo: string; // owner/repo
  commentTag: string;
  breakGlassMarker: string;
  cwd?: string;
  /**
   * Prebuilt link context. When set, linkContextAsync() returns it directly and
   * skips the two `gh` calls — the ci fan-out builds ONE context for all scopes.
   */
  linkContext?: LinkContext;
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface IssueComment {
  id: number;
  body?: string;
  author_association?: string;
}

/**
 * Maintains exactly one PR comment, updating it in place across re-reviews (and
 * cleaning up duplicates) so the review converges instead of churning. Runs the
 * break-glass check first. Comment-only: never calls the review-state APIs.
 */
export class GitHubReporter implements Reporter {
  private readonly marker: string;

  constructor(private readonly options: GitHubReporterOptions) {
    this.marker = commentMarker(options.commentTag);
  }

  async checkBreakGlass(): Promise<boolean> {
    const comments = await this.fetchAllComments();
    return comments.some(
      (comment) =>
        typeof comment.body === "string" &&
        comment.body.includes(this.options.breakGlassMarker) &&
        MAINTAINER_ASSOCIATIONS.has(comment.author_association ?? ""),
    );
  }

  async postSkipNote(): Promise<void> {
    await this.upsertComment(
      `${this.marker}\n🤖 AI review skipped via \`${this.options.breakGlassMarker}\`.`,
    );
  }

  async report(review: CoordinatorOutput): Promise<void> {
    // Carry forward any per-PR dismissals recorded in the existing comment so they
    // survive re-reviews (a dismissed finding stays in the collapsed section).
    const existing = await this.findExistingComment();
    const dismissed = existing
      ? (parseReviewState(existing.body, this.options.commentTag)?.dismissed ?? [])
      : [];
    const link = await this.linkContextAsync();
    await this.upsertComment(renderMarkdown(review, this.options.commentTag, dismissed, link));
  }

  /** Post/update the aggregate multi-scope comment (comment:'single' mode). */
  async reportAggregate(results: ScopeReviewResult[], unmatchedFiles: string[]): Promise<void> {
    const existing = await this.findExistingComment();
    const dismissed = existing
      ? (parseReviewState(existing.body, this.options.commentTag)?.dismissed ?? [])
      : [];
    const link = await this.linkContextAsync();
    await this.upsertComment(
      renderAggregateMarkdown(results, this.options.commentTag, dismissed, link, {
        unmatchedFiles,
      }),
    );
  }

  /**
   * The embedded review state of the existing reviewer comment, or null when no
   * comment (or no parseable state) exists. A partial ci run (--scopes) uses this
   * to carry the non-rerun scopes' previous results into the new aggregate.
   */
  async readState(): Promise<ReviewState | null> {
    const existing = await this.findExistingComment();
    return existing ? parseReviewState(existing.body, this.options.commentTag) : null;
  }

  /**
   * Delete every comment carrying THIS reporter's full marker (stale-scope cleanup /
   * mode switch). Only ever touches its own marker — `<!-- tag -->` is not a substring
   * of `<!-- tag:scope -->`, so root vs scoped markers can't cross-match (the
   * reviewdog #1911 lesson).
   */
  async clear(): Promise<void> {
    const marked = (await this.fetchAllComments()).filter((comment) =>
      comment.body?.includes(this.marker),
    );
    for (const comment of marked) {
      await this.deleteComment(comment.id);
    }
  }

  /**
   * PR context for turning finding locations into links: the set of lines actually
   * in the diff (for in-diff findings → diff-anchor links) and the base commit SHA
   * (for out-of-diff findings → source-blob links on the base). Both fetches fail
   * soft — a missing piece just degrades to a plain-text location, never a dead link.
   */
  private async linkContextAsync(): Promise<LinkContext> {
    // A prebuilt context (ci fan-out, one fetch shared across scopes) wins — skip
    // the two `gh` calls entirely.
    if (this.options.linkContext) {
      return this.options.linkContext;
    }
    const link: LinkContext = { repo: this.options.repo, prNumber: this.options.prNumber };
    const prArgs = [String(this.options.prNumber), "--repo", this.options.repo];
    const cwd = this.options.cwd;
    await Promise.all([
      (async () => {
        try {
          const { stdout } = await run("gh", ["pr", "diff", ...prArgs], { cwd });
          link.diffLines = buildDiffLineIndex(parseUnifiedDiff(stdout));
        } catch {
          // leave diffLines unset → in-diff findings degrade to plain text
        }
      })(),
      (async () => {
        try {
          const { stdout } = await run("gh", ["pr", "view", ...prArgs, "--json", "baseRefOid"], {
            cwd,
          });
          const oid = (JSON.parse(stdout) as { baseRefOid?: string }).baseRefOid;
          if (oid) {
            link.baseSha = oid;
          }
        } catch {
          // leave baseSha unset → out-of-diff findings degrade to plain text
        }
      })(),
    ]);
    return link;
  }

  /**
   * Add or remove per-PR finding dismissals in the reviewer's comment and re-render
   * it in place — no re-review needed (the comment embeds the full review state).
   */
  async applyDismissal(
    add: string[],
    remove: string[],
    by?: string,
    reason?: string,
  ): Promise<DismissalResult> {
    const existing = await this.findExistingComment();
    if (!existing) {
      throw new Error("No reviewer comment found on this PR yet — run a review first.");
    }
    const state = parseReviewState(existing.body, this.options.commentTag);
    if (!state) {
      throw new Error(
        "The reviewer comment has no embedded state (posted before dismissals existed); re-run a review first.",
      );
    }
    // Scope-aware validity: on an aggregate comment the ids are scope-namespaced, so
    // validate against every scope's scoped fingerprints; otherwise the plain ones.
    const isAggregate = Array.isArray(state.scopes) && state.scopes.length > 0;
    const validFps = isAggregate
      ? new Set(
          state.scopes!.flatMap((scope) =>
            scope.review.findings.map((finding) =>
              scopedFingerprint(scope.isDefault ? null : scope.scope, finding),
            ),
          ),
        )
      : new Set(state.review.findings.map(fingerprintFinding));
    const matched = add.filter((fp) => validFps.has(fp));
    const unmatched = add.filter((fp) => !validFps.has(fp));

    const dismissed: DismissalRecord[] = state.dismissed.filter(
      (record) => !remove.includes(record.fp),
    );
    for (const fp of matched) {
      if (!dismissed.some((record) => record.fp === fp)) {
        dismissed.push({ fp, by, reason });
      }
    }

    const link = await this.linkContextAsync();
    const body = isAggregate
      ? renderAggregateMarkdown(state.scopes!, this.options.commentTag, dismissed, link)
      : renderMarkdown(state.review, this.options.commentTag, dismissed, link);
    await this.patchComment(existing.id, body);
    return { dismissedCount: dismissed.length, matched, unmatched };
  }

  /** Newest reviewer-tagged comment (id + body), or null if none posted yet. */
  private async findExistingComment(): Promise<{ id: number; body: string } | null> {
    const marked = (await this.fetchAllComments()).filter((comment) =>
      comment.body?.includes(this.marker),
    );
    const keep = marked[marked.length - 1];
    return keep ? { id: keep.id, body: keep.body ?? "" } : null;
  }

  // Safety cap on pagination (100/page): 30 pages = 3000 comments. Bounds a
  // pathological PR; virtually every real PR exits far earlier.
  private static readonly MAX_COMMENT_PAGES = 30;

  /**
   * Fetch ALL issue comments, paginating manually (a single page's array is valid
   * JSON; `--paginate` concatenates arrays into invalid JSON). The issue-comments
   * endpoint does NOT honor `sort`/`direction`, so results come back oldest-first
   * — we must page to the end to see the newest comments (our own prior comment or
   * a recent `/skip-review` can otherwise fall outside a single 100-comment window,
   * causing duplicate comments and missed break-glass).
   */
  private async fetchAllComments(): Promise<IssueComment[]> {
    const all: IssueComment[] = [];
    for (let page = 1; page <= GitHubReporter.MAX_COMMENT_PAGES; page++) {
      const { stdout } = await run(
        "gh",
        [
          "api",
          "-X",
          "GET",
          `repos/${this.options.repo}/issues/${this.options.prNumber}/comments`,
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ],
        { cwd: this.options.cwd },
      );
      let batch: IssueComment[];
      try {
        batch = JSON.parse(stdout) as IssueComment[];
      } catch {
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }
      all.push(...batch);
      if (batch.length < 100) {
        break;
      }
    }
    return all;
  }

  /**
   * Update the reviewer's existing comment if present (deleting older duplicates),
   * otherwise create it. Comments come back oldest-first, so the LAST marked one
   * is the newest and is the keeper.
   */
  private async upsertComment(body: string): Promise<void> {
    const marked = (await this.fetchAllComments()).filter((comment) =>
      comment.body?.includes(this.marker),
    );

    if (marked.length === 0) {
      await this.createComment(body);
      return;
    }

    const keep = marked[marked.length - 1]!;
    const duplicates = marked.slice(0, -1);
    await this.patchComment(keep.id, body);
    for (const duplicate of duplicates) {
      await this.deleteComment(duplicate.id);
    }
  }

  private async withBodyFile<T>(body: string, fn: (jsonPath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "ecr-"));
    const jsonPath = path.join(dir, "comment.json");
    try {
      await writeFile(jsonPath, JSON.stringify({ body }), "utf8");
      return await fn(jsonPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async createComment(body: string): Promise<void> {
    await this.withBodyFile(body, (jsonPath) =>
      run(
        "gh",
        [
          "api",
          "-X",
          "POST",
          `repos/${this.options.repo}/issues/${this.options.prNumber}/comments`,
          "--input",
          jsonPath,
        ],
        { cwd: this.options.cwd },
      ),
    );
  }

  private async patchComment(commentId: number, body: string): Promise<void> {
    await this.withBodyFile(body, (jsonPath) =>
      run(
        "gh",
        [
          "api",
          "-X",
          "PATCH",
          `repos/${this.options.repo}/issues/comments/${commentId}`,
          "--input",
          jsonPath,
        ],
        { cwd: this.options.cwd },
      ),
    );
  }

  private async deleteComment(commentId: number): Promise<void> {
    await run(
      "gh",
      ["api", "-X", "DELETE", `repos/${this.options.repo}/issues/comments/${commentId}`],
      { cwd: this.options.cwd },
    );
  }
}
