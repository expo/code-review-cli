// @ref LLP 0005#review-result-cache [constrained-by] — prior-review context is a review INPUT, so it belongs in the cache key like every other input
/**
 * What the last review of this pull request reported, reduced to the smallest
 * shape a reviewer needs to avoid repeating itself.
 *
 * The source is `ReviewState`, which already round-trips through the reviewer's
 * own PR comment on every run — findings, dismissals, author replies and pins.
 * Nothing new is fetched or stored; that state was simply never shown to the
 * model, which is why every re-review starts from zero.
 *
 * Trust: this is NOT trusted input. The titles and paths are model output
 * derived from reading an untrusted pull request — `stripStateMarkers` exists
 * precisely because a forged marker can arrive inside a model-written rationale.
 * It is therefore capped here and sanitized + fenced at the prompt boundary,
 * exactly like external context text and documentation passages.
 */
import type { ReviewState } from "./render.js";
import type { FeedbackRecord, Finding } from "./schema.js";

/** Cap the carried set: this is a reminder, not a second copy of the review. */
const MAX_PRIOR_FINDINGS = 40;

/**
 * What became of a finding after it was reported. Only `dismissed` and
 * `answered` change reviewer behavior; both mean a human already engaged with
 * it, so re-raising it unchanged is noise.
 *
 * `answered` therefore means the reply actually CLEARED the finding, not merely
 * that someone replied. A reply that only annotates — a quote without the `id:`
 * token, a third-party commenter, a `critical`/`secrets`/`security` finding the
 * hard floors protect — stays `open`, because telling the reviewer "a human
 * handled this" for a finding the floors refuse to clear is exactly the
 * suppression those floors exist to prevent.
 */
export type PriorFindingStatus = "open" | "dismissed" | "answered";

export interface PriorReviewFinding {
  file: string;
  line: number | null;
  severity: string;
  category: string;
  title: string;
  status: PriorFindingStatus;
}

export interface PriorReview {
  findings: PriorReviewFinding[];
  /** Findings dropped by the cap, so the prompt can say so rather than imply completeness. */
  omitted: number;
}

function statusOf(
  fingerprint: string,
  dismissed: ReadonlySet<string>,
  answered: boolean,
  pinned: ReadonlySet<string>,
): PriorFindingStatus {
  // A pin is a maintainer explicitly restoring a finding a reply had cleared, so
  // it outranks both — the human's last word was "this still stands".
  if (pinned.has(fingerprint)) return "open";
  if (dismissed.has(fingerprint)) return "dismissed";
  if (answered) return "answered";
  return "open";
}

/**
 * Reduce the embedded state of the previous review to the prior-review context
 * block's input. Returns undefined when there is nothing useful to carry, so the
 * caller can omit the section entirely rather than emit an empty one.
 */
export function summarizePriorReview(
  state: ReviewState | null | undefined,
  fingerprintOf: (finding: Finding) => string,
  /**
   * The SAME predicate the reporter uses to decide whether a reply clears a
   * finding — `feedbackApplied` bound to this run's feedback config. Injected
   * rather than imported so this module stays pure, and so the two can never
   * drift into disagreeing about what "answered" means.
   */
  replyCleared: (finding: Finding, record: FeedbackRecord) => boolean,
): PriorReview | undefined {
  const findings = state?.review?.findings ?? [];
  if (findings.length === 0) return undefined;

  const dismissed = new Set<string>((state?.dismissed ?? []).map((record) => record.fp));
  const pinned = new Set<string>((state?.pins ?? []).map((pin) => pin.fp));
  const recordsByFingerprint = new Map<string, FeedbackRecord>(
    (state?.feedback ?? []).map((record) => [record.fp, record]),
  );

  const kept = findings.slice(0, MAX_PRIOR_FINDINGS).map((finding: Finding) => {
    const fingerprint = fingerprintOf(finding);
    const record = recordsByFingerprint.get(fingerprint);
    const answered = record ? replyCleared(finding, record) : false;
    return {
      file: finding.file,
      line: finding.line ?? null,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      status: statusOf(fingerprint, dismissed, answered, pinned),
    };
  });

  return { findings: kept, omitted: Math.max(0, findings.length - kept.length) };
}
