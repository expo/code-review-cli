// @ref LLP 0008#github-reporter-identity — the reporter's core problem: which PR comment is ours; identity is proven by author + marker, never marker alone
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveTrustedTool, run } from "../core/exec.js";
import { parseUnifiedDiff } from "../core/diff.js";
import {
  buildDiffLineIndex,
  commentMarker,
  parseReviewState,
  renderAggregateMarkdown,
  renderMarkdown,
} from "../core/render.js";
import type { LinkContext, ReviewState, ScopeReviewResult } from "../core/render.js";
import { matchReplies } from "../core/responses.js";
import type { ReplyComment } from "../core/responses.js";
import { feedbackApplied } from "../core/adjudicate.js";
import type { AdjudicationItem } from "../core/adjudicate.js";
import { fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type {
  CoordinatorOutput,
  DismissalRecord,
  FeedbackRecord,
  Finding,
} from "../core/schema.js";
import type { LoadedConfig } from "../config/schema.js";
import { appendStepSummary } from "../core/step-summary.js";
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
  /**
   * Root-only author-feedback config (see LoadedConfig.feedback). Absent (the
   * default for existing callers) or `mode: "off"` disables the whole path, so
   * the reporter behaves exactly as before until a caller opts in.
   */
  feedback?: LoadedConfig["feedback"];
  /**
   * The head commit this run reviews (the PR's immutable head OID, from the source's
   * metadata). Feedback merging binds a stored verdict to the source it judged, so a
   * verdict only carries forward while this matches what the record recorded. Absent —
   * a caller that runs no review (the `ecr feedback` crawl, a dismissal re-render) or
   * a source with no resolvable OID — reads as "unknown source": stored verdicts are
   * dropped and re-judged rather than trusted, which costs budget but never hides a
   * finding against source the rebuttal no longer fits.
   */
  headSha?: string;
  /**
   * Identity override: treat comments authored by THIS login as the reviewer's
   * own, instead of resolving the current `gh` identity. Needed by the
   * `ecr feedback` crawl on a developer machine: the reviewer comment was posted
   * by CI (`github-actions[bot]` under the default token), so matching the local
   * human login would find no comment on any PR. Read-only callers only — a
   * posting reporter must keep the real identity or it would edit someone
   * else's comments.
   */
  ownLogin?: string;
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface IssueComment {
  id: number;
  body?: string;
  author_association?: string;
  /** The comment's author. GitHub sets this from the authenticated identity; it
   * cannot be forged, so it — not the public body marker — is the identity signal. */
  user?: { login?: string };
  /** Permalink to the comment, used as the reply link on an annotated finding. */
  html_url?: string;
}

// @ref LLP 0011#suppression-is-never-silent [implements] — a decision carries only while BOTH the reply and the reviewed source are unchanged; anything else is re-judged
/**
 * Carry a decision (verdict / applied) already recorded in the prior comment
 * state onto the freshly matched records — but only when the current newest
 * reply is the SAME comment it was made about AND the stored verdict judged the
 * SAME source revision (`headSha`). A newer reply resets it: the old verdict judged
 * different words. A newer head resets it too: a verdict is a claim about code, and
 * a fingerprint excludes the line number, so the author can edit the code the
 * rebuttal relied on away while the finding keeps its identity — carrying the
 * verdict there would hide a finding against source that no longer supports it.
 * Unknown source (no `headSha` for this run, or a record stored before the field
 * existed) counts as different: the decision is dropped and adjudicateFeedback
 * judges the reply again. Fresh records own the reply identity (author, comment id,
 * link); the prior state owns the decision.
 */
function mergeFeedback(
  fresh: FeedbackRecord[],
  previous: FeedbackRecord[],
  headSha: string | undefined,
): FeedbackRecord[] {
  const priorByFp = new Map(previous.map((record) => [record.fp, record]));
  return fresh.map((record) => {
    const prior = priorByFp.get(record.fp);
    if (prior && prior.commentId === record.commentId) {
      // Only a verdict is bound to a revision. A record with none (a maintainer reply,
      // an unjudged annotation) has no source-dependent decision to go stale, so it
      // carries exactly as before.
      const carries =
        prior.verdict === undefined || (headSha !== undefined && prior.sourceSha === headSha);
      return {
        ...record,
        ...(carries && prior.verdict !== undefined ? { verdict: prior.verdict } : {}),
        ...(carries && prior.reason !== undefined ? { reason: prior.reason } : {}),
        ...(carries && prior.sourceSha !== undefined ? { sourceSha: prior.sourceSha } : {}),
        // A `/undismiss` override is pinned to the reply it restored: carry it forward
        // for the SAME comment so a re-review's `applied` recompute keeps the finding
        // active (a newer reply is a fresh decision and drops the pin, like the verdict).
        // It survives a source change too — a human restored the finding, and only a
        // newer reply may lift that.
        ...(prior.unclearedByHuman ? { unclearedByHuman: true } : {}),
        // A dropped verdict takes its `applied` with it (every caller recomputes it
        // anyway); carrying `true` here would keep the finding hidden for one render.
        applied: carries ? prior.applied : false,
      };
    }
    return record;
  });
}

// @ref LLP 0011#deterministic-matching [implements] — the pure core of matchAdjudicationItems: no IO, so it is unit-testable; the caller supplies the fetched state/replies
/**
 * Pair each matched reply with the finding it answers and its raw reply text, carrying
 * any prior verdict forward. Pure: the caller has already fetched `previousFeedback`
 * (the comment's stored records) and `replies`. `fpOf` MUST key findings the same way
 * that comment stores them (scope-namespaced for an aggregate comment, plain otherwise)
 * or a prior verdict can never carry — its fp would not match the fresh record's.
 * `headSha` is the source revision being reviewed: a stored verdict carries only when
 * it judged that same revision (see mergeFeedback). Exported for tests.
 */
export function buildAdjudicationItems(
  review: CoordinatorOutput,
  previousFeedback: FeedbackRecord[],
  replies: ReplyComment[],
  fpOf: (finding: Finding) => string,
  match: "quote" | "id" | "both",
  headSha?: string,
): AdjudicationItem[] {
  const withFp = review.findings.map((finding) => ({ finding, fp: fpOf(finding) }));
  const records = mergeFeedback(
    matchReplies(replies, withFp, { match }),
    previousFeedback,
    headSha,
  );
  const findingByFp = new Map(withFp.map((entry) => [entry.fp, entry.finding]));
  const bodyById = new Map(replies.map((reply) => [reply.id, reply.body]));
  const items: AdjudicationItem[] = [];
  for (const record of records) {
    const finding = findingByFp.get(record.fp);
    if (!finding) {
      continue;
    }
    items.push({ finding, record, replyText: bodyById.get(record.commentId) ?? "" });
  }
  return items;
}

/**
 * The reviewer's OWN marker comments, oldest-first: carrying the marker AND authored
 * by `ownLogin`. The body marker alone is not identity — it defaults to a hardcoded,
 * public literal and is readable in the base-branch config, so anyone who can comment
 * on the PR (the untrusted PR author included) could post a comment carrying it plus a
 * forged embedded review state; a newest-marker-wins lookup would then adopt that
 * state and carry its `dismissed` list forward, silently suppressing real findings.
 * GitHub sets a comment's author from the authenticated identity and it cannot be
 * spoofed, so matching on author closes that. When `ownLogin` is null the author
 * cannot be confirmed, so NOTHING is treated as ours (fail closed). Pure; exported for
 * tests.
 */
// @ref LLP 0008#github-reporter-identity [constrained-by] — marker-only matching would let a forged comment (from the untrusted PR author) carry forged dismissal state forward; author+marker is what makes identity unspoofable
export function selectOwnComments(
  comments: IssueComment[],
  marker: string,
  ownLogin: string | null,
): IssueComment[] {
  if (!ownLogin) {
    return [];
  }
  return comments.filter(
    (comment) => comment.body?.includes(marker) && comment.user?.login === ownLogin,
  );
}

/**
 * Maintains exactly one PR comment, updating it in place across re-reviews (and
 * cleaning up duplicates) so the review converges instead of churning. Runs the
 * break-glass check first. Comment-only: never calls the review-state APIs.
 */
export class GitHubReporter implements Reporter {
  private readonly marker: string;
  /** Memoized login of the account this reporter posts as (see resolveOwnLogin). */
  private ownLoginResolution?: Promise<string | null>;

  constructor(private readonly options: GitHubReporterOptions) {
    this.marker = commentMarker(options.commentTag);
  }

  /**
   * The login of the account this reporter comments as, so its own comment is
   * recognized by AUTHOR (see selectOwnComments for why the body marker is not enough).
   * Resolution: `gh api user` (a user/PAT token), else the scaffolded workflow's default
   * GITHUB_TOKEN identity, `github-actions[bot]`, when running under Actions — an
   * installation token can't read `/user`. Null when neither is available, which makes
   * selectOwnComments treat no comment as ours (fail closed). Memoized: the identity is
   * stable for the process, and every reporter method consults it.
   */
  private resolveOwnLogin(): Promise<string | null> {
    if (this.options.ownLogin) {
      return Promise.resolve(this.options.ownLogin);
    }
    this.ownLoginResolution ??= (async () => {
      try {
        const gh = await resolveTrustedTool("gh");
        const { stdout } = await run(gh, ["api", "user", "--jq", ".login"], {
          cwd: this.options.cwd,
        });
        const login = stdout.trim();
        if (login) {
          return login;
        }
      } catch {
        // The default GITHUB_TOKEN is an installation token: `/user` returns 403.
      }
      return process.env.GITHUB_ACTIONS ? "github-actions[bot]" : null;
    })();
    return this.ownLoginResolution;
  }

  /** Memoized login of the PR author (see resolvePrAuthor). */
  private prAuthorResolution?: Promise<string | null>;

  /**
   * The PR author's login, used to mark a reply as coming from the author (see
   * replyComments) so the adjudicated clear path can gate on it. Resolved via
   * `gh pr view --json author`; memoized (stable for the PR) and fail-soft — a null
   * result marks no reply as the author's, so the adjudicated path clears nothing
   * (fail closed), exactly like an unresolved own-login.
   */
  private resolvePrAuthor(): Promise<string | null> {
    this.prAuthorResolution ??= (async () => {
      try {
        const gh = await resolveTrustedTool("gh");
        const { stdout } = await run(
          gh,
          [
            "pr",
            "view",
            String(this.options.prNumber),
            "--repo",
            this.options.repo,
            "--json",
            "author",
            "--jq",
            ".author.login",
          ],
          { cwd: this.options.cwd },
        );
        const login = stdout.trim();
        return login || null;
      } catch {
        // No PR author resolvable (missing PR, API error): fail closed — no reply is
        // treated as the author's, so nothing clears via the adjudicated path.
        return null;
      }
    })();
    return this.prAuthorResolution;
  }

  /** This reporter's own marker comments, author-verified (see selectOwnComments). */
  private async ownComments(): Promise<IssueComment[]> {
    const [comments, ownLogin] = await Promise.all([
      this.fetchAllComments(),
      this.resolveOwnLogin(),
    ]);
    return selectOwnComments(comments, this.marker, ownLogin);
  }

  // @ref LLP 0008#comment-lifecycle [constrained-by] — gates on author_association (OWNER/MEMBER/COLLABORATOR), not on posting the marker string, so only a maintainer can skip review
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

  /**
   * Post/update the single-scope comment. When `feedback` is supplied (the
   * adjudication path already matched + judged the replies) it is rendered as-is;
   * otherwise the reporter matches live replies to this review's findings itself
   * (annotate mode). Either way the feedback path fails soft — it never blocks the
   * comment from being posted.
   */
  async report(review: CoordinatorOutput, feedback?: FeedbackRecord[]): Promise<void> {
    // Carry forward any per-PR dismissals recorded in the existing comment so they
    // survive re-reviews (a dismissed finding stays in the collapsed section).
    const existing = await this.findExistingComment();
    const state = existing ? parseReviewState(existing.body, this.options.commentTag) : null;
    const dismissed = state?.dismissed ?? [];
    const withFp = review.findings.map((finding) => ({
      finding,
      fp: fingerprintFinding(finding),
    }));
    const records = feedback ?? (await this.computeFeedback(withFp, state?.feedback ?? []));
    const link = await this.linkContextAsync();
    await this.upsertComment(
      renderMarkdown(review, this.options.commentTag, dismissed, link, records),
    );
  }

  /** Post/update the aggregate multi-scope comment (comment:'single' mode). */
  async reportAggregate(
    results: ScopeReviewResult[],
    unmatchedFiles: string[],
    feedback?: FeedbackRecord[],
  ): Promise<void> {
    const existing = await this.findExistingComment();
    const state = existing ? parseReviewState(existing.body, this.options.commentTag) : null;
    const dismissed = state?.dismissed ?? [];
    // Feedback is keyed by the SAME scope-namespaced id the aggregate comment
    // renders, so a record can never drift across scopes.
    const withFp = results.flatMap((result) =>
      result.review.findings.map((finding) => ({
        finding,
        fp: scopedFingerprint(result.isDefault ? null : result.scope, finding),
      })),
    );
    const records = feedback ?? (await this.computeFeedback(withFp, state?.feedback ?? []));
    const link = await this.linkContextAsync();
    await this.upsertComment(
      renderAggregateMarkdown(
        results,
        this.options.commentTag,
        dismissed,
        link,
        { unmatchedFiles },
        records,
      ),
    );
  }

  /**
   * Pair each matched PR reply with the finding it answers and its raw reply text —
   * the input the adjudication step (core/review.ts) judges against the source. Any
   * verdict already decided in the prior comment state is carried forward (so a reply
   * is not re-judged for the same words). The reply text rides only the transient
   * AdjudicationItem: it feeds the adjudicator prompt and is never stored on a record
   * or rendered (see FeedbackRecordSchema). Gated on `mode !== "off"`. A fetch/parse
   * error THROWS — the caller (runReview's feedback step) catches it and continues
   * without records, which lets report() fall back to computeFeedback and preserve
   * the previously recorded state; returning `[]` here would wipe it instead.
   *
   * `fpOf` MUST key findings the same way the comment this review lands in stores its
   * feedback: scope-namespaced for the aggregate (comment:'single') comment, plain
   * for a single/per-scope one. A mismatch would leave every fresh record keyed
   * differently from the prior state, so mergeFeedback would carry no verdict and the
   * budget would be re-spent judging the same words each run.
   */
  async matchAdjudicationItems(
    review: CoordinatorOutput,
    fpOf: (finding: Finding) => string = fingerprintFinding,
  ): Promise<AdjudicationItem[]> {
    const config = this.options.feedback;
    if (!config || config.mode === "off") {
      return [];
    }
    // Deliberately NOT wrapped in a swallow-all: a fetch error here must propagate so
    // runReview's own catch leaves `feedback` undefined — then report() falls back to
    // computeFeedback, whose error path preserves the previously recorded state. A
    // caught `[]` instead reads downstream as "there are no replies" and would wipe
    // prior annotations (and un-hide reply-cleared findings) on a transient API error.
    const existing = await this.findExistingComment();
    const state = existing ? parseReviewState(existing.body, this.options.commentTag) : null;
    const replies = await this.replyComments();
    return buildAdjudicationItems(
      review,
      state?.feedback ?? [],
      replies,
      fpOf,
      config.match,
      this.options.headSha,
    );
  }

  /**
   * Read what humans pushed back on for THIS PR from the comment already posted:
   * decode its embedded findings, match the non-bot replies, and merge any prior
   * verdict. Works retroactively — the bot comment embeds its own findings, so no
   * re-review is needed. `ecr feedback` crawls history through this. Fails soft:
   * missing/unparseable comment ⇒ empty result, never a throw.
   */
  async collectFeedback(): Promise<{
    findings: Array<{ finding: Finding; fp: string }>;
    records: FeedbackRecord[];
  }> {
    try {
      const existing = await this.findExistingComment();
      const state = existing ? parseReviewState(existing.body, this.options.commentTag) : null;
      if (!state) {
        return { findings: [], records: [] };
      }
      // An aggregate comment namespaces ids per scope; a single comment does not.
      const withFp =
        state.scopes && state.scopes.length > 0
          ? state.scopes.flatMap((scope) =>
              scope.review.findings.map((finding) => ({
                finding,
                fp: scopedFingerprint(scope.isDefault ? null : scope.scope, finding),
              })),
            )
          : state.review.findings.map((finding) => ({ finding, fp: fingerprintFinding(finding) }));
      const replies = await this.replyComments();
      // The retroactive crawl reports on any recorded pushback regardless of
      // `mode`; only the match strategy is honored (default "both"). The crawl reviews
      // nothing, so it has no head SHA to compare against: stored verdicts do not carry
      // here. That costs the report nothing — it renders who replied and where, never a
      // verdict — and keeps "unknown source" uniformly non-carrying.
      const records = mergeFeedback(
        matchReplies(replies, withFp, { match: this.options.feedback?.match ?? "both" }),
        state.feedback ?? [],
        this.options.headSha,
      );
      return { findings: withFp, records };
    } catch {
      return { findings: [], records: [] };
    }
  }

  // @ref LLP 0011#deterministic-matching [implements] — replies are matched to findings deterministically; the reporter never lets a model pick which finding a reply answers
  /**
   * The matched, merged feedback records to render, or none. Gated on
   * `mode !== "off"` (the annotate/adjudicate switch) and wrapped so a fetch or
   * match error degrades to the records already recorded — a review is never
   * blocked by the feedback path.
   */
  private async computeFeedback(
    withFp: Array<{ finding: Finding; fp: string }>,
    previous: FeedbackRecord[],
  ): Promise<FeedbackRecord[]> {
    const config = this.options.feedback;
    // `applied` is a function of the CURRENT config, never a stored fact: a carried
    // record's flag was computed under the config of the run that stored it, so a
    // repo flipping `dismiss` back to "never" (or `mode` to "off") must un-hide the
    // finding on the next render, not keep honoring the old policy.
    const findingByFp = new Map(withFp.map((entry) => [entry.fp, entry.finding]));
    const reapply = (records: FeedbackRecord[]): FeedbackRecord[] =>
      records.map((record) => {
        const finding = findingByFp.get(record.fp);
        // With no feedback config at all, the feature is disabled, so nothing is
        // applied — but the record itself (who replied, any verdict) is preserved.
        if (!config) {
          return { ...record, applied: false };
        }
        return finding ? { ...record, applied: feedbackApplied(finding, record, config) } : record;
      });
    // mode "off" (or no config) preserves the previously recorded records and only
    // stops matching NEW replies. Returning [] here would let render's reviewState
    // drop the feedback key entirely, permanently losing every recorded reply, verdict
    // and reply-dismissal decision — mirror applyDismissal, which keeps feedback on a
    // re-render. `applied` is still recomputed (→ false under "off"), so a finding a
    // reply had cleared correctly returns to the active list.
    if (!config || config.mode === "off") {
      return reapply(previous);
    }
    try {
      const replies = await this.replyComments();
      return reapply(
        mergeFeedback(
          matchReplies(replies, withFp, { match: config.match }),
          previous,
          this.options.headSha,
        ),
      );
    } catch {
      return reapply(previous);
    }
  }

  // @ref LLP 0008#github-reporter-identity [implements] — a reply is any comment NOT authored by us and NOT carrying our marker; author identity (user.login) is what excludes our own, never the forgeable marker alone
  /**
   * The PR's human replies, as the matcher consumes them. Excludes comments we
   * authored (by unspoofable `user.login`) and any comment carrying our marker, so
   * our own footer is never read back as a reply; the `author_association` gives
   * the maintainer flag and the PR author's login gives the `author` flag. When our
   * login can't be resolved, the marker filter still keeps our own comments out.
   */
  private async replyComments(): Promise<ReplyComment[]> {
    const [comments, ownLogin, prAuthor] = await Promise.all([
      this.fetchAllComments(),
      this.resolveOwnLogin(),
      this.resolvePrAuthor(),
    ]);
    const out: ReplyComment[] = [];
    for (const comment of comments) {
      const login = comment.user?.login;
      if (!login || (ownLogin && login === ownLogin)) {
        continue;
      }
      if (comment.body?.includes(this.marker)) {
        continue;
      }
      out.push({
        id: comment.id,
        body: comment.body ?? "",
        login,
        maintainer: MAINTAINER_ASSOCIATIONS.has(comment.author_association ?? ""),
        // Trusted-for-adjudication identity: the reply is from the PR author. Derived
        // from the unspoofable comment author, not the (public) marker or reply text.
        author: prAuthor != null && login === prAuthor,
        ...(comment.html_url ? { url: comment.html_url } : {}),
      });
    }
    return out;
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
    // Only ever delete comments WE authored — never touch a look-alike posted by
    // someone else (see selectOwnComments).
    for (const comment of await this.ownComments()) {
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
          const gh = await resolveTrustedTool("gh");
          const { stdout } = await run(gh, ["pr", "diff", ...prArgs], { cwd });
          link.diffLines = buildDiffLineIndex(parseUnifiedDiff(stdout));
        } catch {
          // leave diffLines unset → in-diff findings degrade to plain text
        }
      })(),
      (async () => {
        try {
          const gh = await resolveTrustedTool("gh");
          const { stdout } = await run(gh, ["pr", "view", ...prArgs, "--json", "baseRefOid"], {
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
  // @ref LLP 0008#comment-lifecycle [implements] — validates added fingerprints against the CURRENT review's valid set, scope-aware (scoped fingerprints for an aggregate comment, plain otherwise), rather than trusting caller-supplied ids
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

    // Keep any recorded author responses on the re-render — a /dismiss must not
    // strip the feedback annotations already embedded in the comment state. A
    // /undismiss (an fp in `remove`) must also restore a finding a REPLY cleared, not
    // just a manual dismissal: un-apply that record and pin it (`unclearedByHuman`) so
    // a later re-review recomputing `applied` from the still-present reply keeps the
    // finding active instead of re-hiding it forever.
    const removeSet = new Set(remove);
    const feedback = (state.feedback ?? []).map((record) =>
      removeSet.has(record.fp) ? { ...record, applied: false, unclearedByHuman: true } : record,
    );
    const link = await this.linkContextAsync();
    const body = isAggregate
      ? renderAggregateMarkdown(
          state.scopes!,
          this.options.commentTag,
          dismissed,
          link,
          undefined,
          feedback,
        )
      : renderMarkdown(state.review, this.options.commentTag, dismissed, link, feedback);
    await this.patchComment(existing.id, body);
    return { dismissedCount: dismissed.length, matched, unmatched };
  }

  /** Newest comment WE authored carrying our marker (id + body), or null if none. */
  private async findExistingComment(): Promise<{ id: number; body: string } | null> {
    const own = await this.ownComments();
    const keep = own[own.length - 1];
    return keep ? { id: keep.id, body: keep.body ?? "" } : null;
  }

  // Safety cap on pagination (100/page): 30 pages = 3000 comments. Bounds a
  // pathological PR; virtually every real PR exits far earlier.
  private static readonly MAX_COMMENT_PAGES = 30;

  /** How long a fetched comment list may be reused (see fetchAllComments). */
  private static readonly COMMENTS_CACHE_TTL_MS = 30_000;
  private commentsCache?: { at: number; comments: Promise<IssueComment[]> };

  /**
   * Burst-collapsing cache over fetchAllCommentsUncached. One logical operation
   * fans out into several comment reads (readState + collectFeedback in the
   * `ecr feedback` crawl; findExistingComment + replyComments + upsert in a
   * report) that would each re-fetch the identical paginated list. The TTL is
   * deliberately short: across a real gap (break-glass check → 30-minute review →
   * post) a stale list could miss a fresh `/skip-review` or a new duplicate, so
   * only back-to-back calls coalesce. Any comment mutation invalidates it.
   */
  private fetchAllComments(): Promise<IssueComment[]> {
    const now = Date.now();
    if (!this.commentsCache || now - this.commentsCache.at > GitHubReporter.COMMENTS_CACHE_TTL_MS) {
      const comments = this.fetchAllCommentsUncached().catch((error: unknown) => {
        // Never cache a failure.
        this.commentsCache = undefined;
        throw error;
      });
      this.commentsCache = { at: now, comments };
    }
    return this.commentsCache.comments;
  }

  private invalidateComments(): void {
    this.commentsCache = undefined;
  }

  /**
   * Fetch ALL issue comments, paginating manually (a single page's array is valid
   * JSON; `--paginate` concatenates arrays into invalid JSON). The issue-comments
   * endpoint does NOT honor `sort`/`direction`, so results come back oldest-first
   * — we must page to the end to see the newest comments (our own prior comment or
   * a recent `/skip-review` can otherwise fall outside a single 100-comment window,
   * causing duplicate comments and missed break-glass).
   */
  // @ref LLP 0008#comment-lifecycle [constrained-by] — the issue-comments endpoint ignores sort/direction and returns oldest-first; pagination must reach the end or the newest comment (ours, or a recent break-glass) can fall outside the window
  private async fetchAllCommentsUncached(): Promise<IssueComment[]> {
    const all: IssueComment[] = [];
    const gh = await resolveTrustedTool("gh");
    for (let page = 1; page <= GitHubReporter.MAX_COMMENT_PAGES; page++) {
      const { stdout } = await run(
        gh,
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
  // @ref LLP 0008#comment-lifecycle [implements] — converges to one live comment: patches the newest own-marker comment and deletes older duplicates, never touching a look-alike from someone else
  private async upsertComment(body: string): Promise<void> {
    // Update/clean up only comments WE authored, never a look-alike posted by
    // someone else (see selectOwnComments) — otherwise the newest forged marker
    // comment would be adopted as "ours" and edited/patched in its place.
    const marked = await this.ownComments();

    if (marked.length === 0) {
      await this.createComment(body);
    } else {
      const keep = marked[marked.length - 1]!;
      const duplicates = marked.slice(0, -1);
      await this.patchComment(keep.id, body);
      for (const duplicate of duplicates) {
        await this.deleteComment(duplicate.id);
      }
    }

    // Mirror the exact posted body into the Actions step summary: the PR comment
    // is upserted in place, so this is the only per-run record of what was posted.
    await appendStepSummary(`### 🤖 AI review — posted comment\n\n${body}`);
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
    this.invalidateComments();
    const gh = await resolveTrustedTool("gh");
    await this.withBodyFile(body, (jsonPath) =>
      run(
        gh,
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
    this.invalidateComments();
    const gh = await resolveTrustedTool("gh");
    await this.withBodyFile(body, (jsonPath) =>
      run(
        gh,
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
    this.invalidateComments();
    const gh = await resolveTrustedTool("gh");
    await run(
      gh,
      ["api", "-X", "DELETE", `repos/${this.options.repo}/issues/comments/${commentId}`],
      { cwd: this.options.cwd },
    );
  }
}
