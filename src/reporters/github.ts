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
import { dropStaleVerdict, feedbackApplied, feedbackNeedsPrAuthor } from "../core/adjudicate.js";
import type { AdjudicationItem } from "../core/adjudicate.js";
import { applyPins, collectPins, fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type {
  CoordinatorOutput,
  DismissalRecord,
  FeedbackPin,
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

/**
 * PR-author lookups shared across reporter INSTANCES, keyed by the exact PR they
 * describe. Routed CI builds one GitHubReporter per scope comment (plus one for the
 * aggregate comment), and every one of them would otherwise run its own `gh pr view` for
 * the SAME PR. The key carries the checkout, the repo and the PR number, so a lookup can
 * never leak across repos or PRs in one process (the `ecr feedback` crawl walks many
 * PRs). The in-flight promise is stored, not just the result, so concurrent scopes share
 * one call.
 */
const prAuthorByPr = new Map<string, Promise<string | null>>();

/** Cache key for prAuthorByPr. Newline-joined with the free-form part (the checkout
 * path) LAST: a PR number is digits and a repo is `owner/name`, neither of which can
 * contain a newline, so two different PRs can never collide on one key. Exported for
 * tests. */
export function prAuthorCacheKey(repo: string, prNumber: number, cwd?: string): string {
  return `${prNumber}\n${repo}\n${cwd ?? ""}`;
}

/**
 * Run `resolve` at most once per PR for the lifetime of the process — but cache only a
 * SUCCESSFUL answer. A `gh pr view` that fails (rate limit, network blip) resolves to
 * null, and caching that null would make one transient error fail-close every later
 * scope of the same run: routed CI builds a reporter per scope, all reading this map,
 * so every reply would be marked `author: false` and the adjudicated clear path could
 * not fire again for the whole process. The entry is therefore removed once the promise
 * settles to null (or rejects, which leaves nothing dangling either), so the next scope
 * retries. Concurrency is unchanged: the in-flight promise is what's stored, so
 * simultaneous scopes still join one call rather than each firing their own. Exported
 * for tests (the reporter's own call path needs `gh`).
 */
export function sharedPrAuthor(
  key: string,
  resolve: () => Promise<string | null>,
): Promise<string | null> {
  const cached = prAuthorByPr.get(key);
  if (cached) {
    return cached;
  }
  // Only ever forget OUR entry: a later call may already have started a new lookup.
  const forget = (settled: Promise<string | null>): void => {
    if (prAuthorByPr.get(key) === settled) {
      prAuthorByPr.delete(key);
    }
  };
  const pending: Promise<string | null> = resolve().then(
    (login) => {
      if (login == null) {
        forget(pending);
      }
      return login;
    },
    (error: unknown) => {
      forget(pending);
      throw error;
    },
  );
  prAuthorByPr.set(key, pending);
  return pending;
}

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

// @ref LLP 0011#suppression-is-never-silent [implements] — a verdict carries only while BOTH the reply and the reviewed source are unchanged
/**
 * Carry a decision already recorded in the prior comment state onto the freshly
 * matched records. A **verdict** (and the `applied` it justified) is bound to the words
 * it judged AND to the source it judged: it carries only while the newest reply is the
 * SAME comment it was decided about and `dropStaleVerdict` agrees the head is
 * unchanged. A newer reply answers different words; a newer head means the code the
 * rebuttal relied on may be gone. Either way the reply is re-judged rather than trusted.
 *
 * Fresh records own the reply identity (author, comment id, link); the prior state owns
 * the decision. A maintainer's `/undismiss` pin is NOT merged here — it belongs to the
 * finding, lives in the comment state's own `pins` set, and is stamped back on by
 * `applyPins` (which is what keeps it alive through a run that matches no reply at all).
 */
function mergeFeedback(
  fresh: FeedbackRecord[],
  previous: FeedbackRecord[],
  headSha: string | undefined,
): FeedbackRecord[] {
  const priorByFp = new Map(previous.map((record) => [record.fp, record]));
  return fresh.map((record) => {
    const prior = priorByFp.get(record.fp);
    if (!prior || prior.commentId !== record.commentId) {
      // No prior decision, or different words: nothing decided about the old comment
      // carries.
      return record;
    }
    return dropStaleVerdict(
      {
        ...record,
        ...(prior.verdict !== undefined ? { verdict: prior.verdict } : {}),
        ...(prior.reason !== undefined ? { reason: prior.reason } : {}),
        ...(prior.sourceSha !== undefined ? { sourceSha: prior.sourceSha } : {}),
        applied: prior.applied,
      },
      headSha,
    );
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
 * it judged that same revision (see mergeFeedback). `pins` is the comment's
 * `/undismiss` set: it is stamped onto the matched records so a pinned finding is never
 * re-judged and never re-cleared (a v3 comment's record-level flags migrate in through
 * collectPins). Exported for tests.
 */
export function buildAdjudicationItems(
  review: CoordinatorOutput,
  previousFeedback: FeedbackRecord[],
  replies: ReplyComment[],
  fpOf: (finding: Finding) => string,
  match: "quote" | "id" | "both",
  headSha?: string,
  pins?: FeedbackPin[],
): AdjudicationItem[] {
  const withFp = review.findings.map((finding) => ({ finding, fp: fpOf(finding) }));
  const { records } = applyPins(
    mergeFeedback(matchReplies(replies, withFp, { match }), previousFeedback, headSha),
    collectPins(pins, previousFeedback),
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
 * The findings a posted comment holds, keyed by the id that comment renders them under:
 * scope-namespaced on an aggregate (comment:'single') comment, plain otherwise. This is
 * both the valid-id set a `/dismiss` is checked against and the lookup that re-derives
 * each feedback record's `applied` under the current config.
 */
function stateFindingsById(state: ReviewState): Map<string, Finding> {
  const scopes = state.scopes;
  if (scopes && scopes.length > 0) {
    return new Map(
      scopes.flatMap((scope) =>
        scope.review.findings.map(
          (finding) =>
            [scopedFingerprint(scope.isDefault ? null : scope.scope, finding), finding] as const,
        ),
      ),
    );
  }
  return new Map(state.review.findings.map((finding) => [fingerprintFinding(finding), finding]));
}

/** What a `/dismiss` or `/undismiss` turns the comment's state into. */
export interface DismissalStateUpdate {
  dismissed: DismissalRecord[];
  feedback: FeedbackRecord[];
  pins: FeedbackPin[];
  matched: string[];
  unmatched: string[];
}

// @ref LLP 0011#the-pin-belongs-to-the-finding [implements] — `/undismiss` writes the pin into the state's own pin set (never only onto a reply record), and `/dismiss` is the maintainer action that lifts it
// @ref LLP 0011#hard-floors-in-code [implements] — a re-render is a render: every kept record's `applied` is re-derived from feedbackApplied under the CURRENT config, never carried over as a stored fact
/**
 * The pure state transition behind applyDismissal: which findings end up dismissed,
 * which are pinned back to the active list, and what each feedback record's `applied`
 * flag is under the config in force NOW. Exported for tests (the reporter's own path
 * needs `gh`).
 *
 * Three rules meet here:
 * - a `/dismiss` (an fp in `add`) is only recorded for an id this comment actually
 *   holds, and it LIFTS any pin on that finding — the same trusted hand deciding the
 *   opposite way;
 * - a `/undismiss` (an fp in `remove`) restores a finding a REPLY cleared, not just a
 *   manual dismissal: it pins the finding so a later re-review recomputing `applied`
 *   from the still-present reply keeps it active;
 * - every record's `applied` is then re-derived with `feedbackApplied` — the same single
 *   decision function every other render path uses. Passing a record through untouched
 *   would keep honoring the config of the run that stored it, so a repo that has since
 *   tightened `dismiss` (or widened `protectedCategories`) would leave an unrelated
 *   finding hidden until the next full review. A record whose finding is no longer in
 *   the comment keeps its stored flag, exactly as computeFeedback does.
 */
export function applyDismissalToState(
  state: ReviewState,
  add: string[],
  remove: string[],
  config: LoadedConfig["feedback"] | undefined,
  by?: string,
  reason?: string,
): DismissalStateUpdate {
  const findingById = stateFindingsById(state);
  const matched = add.filter((fp) => findingById.has(fp));
  const unmatched = add.filter((fp) => !findingById.has(fp));

  const dismissed: DismissalRecord[] = state.dismissed.filter(
    (record) => !remove.includes(record.fp),
  );
  for (const fp of matched) {
    if (!dismissed.some((record) => record.fp === fp)) {
      dismissed.push({ fp, by, reason });
    }
  }

  const records = state.feedback ?? [];
  const removeSet = new Set(remove);
  const addSet = new Set(matched);
  const pins = collectPins(state.pins, records).filter((pin) => !addSet.has(pin.fp));
  for (const record of records) {
    if (removeSet.has(record.fp) && !pins.some((pin) => pin.fp === record.fp)) {
      // Pinned against the reply that is current right now: that same reply must not
      // lift the pin later, only a maintainer reply posted after it (see applyPins).
      pins.push({ fp: record.fp, commentId: record.commentId });
    }
  }
  const stamped = applyPins(records, pins);
  const feedback = stamped.records.map((record) => {
    const finding = findingById.get(record.fp);
    // No feedback config ⇒ the feature is off for this caller, so nothing is applied;
    // the record itself (who replied, any verdict) is still preserved.
    if (!config) {
      return { ...record, applied: false };
    }
    return finding ? { ...record, applied: feedbackApplied(finding, record, config) } : record;
  });
  return { dismissed, feedback, pins: stamped.pins, matched, unmatched };
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

  /**
   * The PR author's login, used to mark a reply as coming from the author (see
   * replyComments) so the adjudicated clear path can gate on it. Resolved via
   * `gh pr view --json author` and fail-soft — a null result marks no reply as the
   * author's, so the adjudicated path clears nothing (fail closed), exactly like an
   * unresolved own-login. Memoized per PR across reporter INSTANCES (see
   * prAuthorByPr), not per instance: routed CI builds one reporter per scope for the
   * same PR, and the author's login is a property of the PR, not of the reporter.
   */
  private resolvePrAuthor(): Promise<string | null> {
    const key = prAuthorCacheKey(this.options.repo, this.options.prNumber, this.options.cwd);
    return sharedPrAuthor(key, async () => {
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
    });
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
    // The `/undismiss` pins carry on every render, whether or not this run matched a
    // reply for the pinned finding — the records may come and go, the pin does not.
    const priorRecords = state?.feedback ?? [];
    const pinsIn = collectPins(state?.pins, priorRecords);
    const { records, pins } = feedback
      ? applyPins(feedback, pinsIn)
      : await this.computeFeedback(withFp, priorRecords, pinsIn);
    const link = await this.linkContextAsync();
    await this.upsertComment(
      renderMarkdown(review, this.options.commentTag, dismissed, link, records, pins),
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
    const priorRecords = state?.feedback ?? [];
    const pinsIn = collectPins(state?.pins, priorRecords);
    const { records, pins } = feedback
      ? applyPins(feedback, pinsIn)
      : await this.computeFeedback(withFp, priorRecords, pinsIn);
    const link = await this.linkContextAsync();
    await this.upsertComment(
      renderAggregateMarkdown(
        results,
        this.options.commentTag,
        dismissed,
        link,
        { unmatchedFiles },
        records,
        pins,
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
      state?.pins,
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
      const { records } = applyPins(
        mergeFeedback(
          matchReplies(replies, withFp, { match: this.options.feedback?.match ?? "both" }),
          state.feedback ?? [],
          this.options.headSha,
        ),
        collectPins(state.pins, state.feedback ?? []),
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
    pinsIn: FeedbackPin[],
  ): Promise<{ records: FeedbackRecord[]; pins: FeedbackPin[] }> {
    const config = this.options.feedback;
    // `applied` is a function of the CURRENT config, never a stored fact: a carried
    // record's flag was computed under the config of the run that stored it, so a
    // repo flipping `dismiss` back to "never" (or `mode` to "off") must un-hide the
    // finding on the next render, not keep honoring the old policy.
    const findingByFp = new Map(withFp.map((entry) => [entry.fp, entry.finding]));
    const reapply = (
      records: FeedbackRecord[],
    ): { records: FeedbackRecord[]; pins: FeedbackPin[] } => {
      // Stamp the pins first: `feedbackApplied` reads the pin off the record, and the
      // set — not the record — is what says which finding a maintainer restored.
      const stamped = applyPins(records, pinsIn);
      return {
        pins: stamped.pins,
        records: stamped.records.map((record) => {
          const finding = findingByFp.get(record.fp);
          // With no feedback config at all, the feature is disabled, so nothing is
          // applied — but the record itself (who replied, any verdict) is preserved.
          if (!config) {
            return { ...record, applied: false };
          }
          return finding
            ? { ...record, applied: feedbackApplied(finding, record, config) }
            : record;
        }),
      };
    };
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
   *
   * The PR-author lookup is an extra `gh` call, so it only runs when the flag can
   * actually change an outcome — `dismiss: "adjudicated"` (see feedbackNeedsPrAuthor).
   * Skipping it leaves every reply `author: false`, the same fail-closed answer a
   * failed lookup gives, and under any other `dismiss` value nothing reads the flag.
   */
  private async replyComments(): Promise<ReplyComment[]> {
    const [comments, ownLogin, prAuthor] = await Promise.all([
      this.fetchAllComments(),
      this.resolveOwnLogin(),
      feedbackNeedsPrAuthor(this.options.feedback) ? this.resolvePrAuthor() : null,
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
   * it in place — no re-review needed (the comment embeds the full review state). The
   * decision itself is pure: see applyDismissalToState, which also re-derives every
   * feedback record's `applied` under the current config and carries the `/undismiss`
   * pin set. This is a render like any other, so it must never leave a record hidden
   * under a policy the repo has since changed.
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
    const isAggregate = Array.isArray(state.scopes) && state.scopes.length > 0;
    const next = applyDismissalToState(state, add, remove, this.options.feedback, by, reason);
    const link = await this.linkContextAsync();
    const body = isAggregate
      ? renderAggregateMarkdown(
          state.scopes!,
          this.options.commentTag,
          next.dismissed,
          link,
          undefined,
          next.feedback,
          next.pins,
        )
      : renderMarkdown(
          state.review,
          this.options.commentTag,
          next.dismissed,
          link,
          next.feedback,
          next.pins,
        );
    await this.patchComment(existing.id, body);
    return {
      dismissedCount: next.dismissed.length,
      matched: next.matched,
      unmatched: next.unmatched,
    };
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
