// @ref LLP 0011#the-rebuttal-is-a-hypothesis [implements] — a reply is judged against the SOURCE (via the adjudicator prompt), capped and fail-open; the decision floors live here in code, never in the prompt
import type { LoadedConfig } from "../config/schema.js";
import { addTokenUsage, promptAndParse, VERIFIER_AGENT } from "./opencode.js";
import type { OpencodeHandle, TokenUsage } from "./opencode.js";
import { buildAdjudicatorSystem, buildAdjudicatorTask } from "./prompts.js";
import { parseAdjudication } from "./schema.js";
import type {
  Category,
  FeedbackReason,
  FeedbackRecord,
  FeedbackVerdict,
  Finding,
} from "./schema.js";
import { errorMessage } from "./util.js";

type FeedbackConfig = LoadedConfig["feedback"];

// Adjudication runs after coordination/verification (a serial tail step) and in
// parallel over records; keep the per-call bound in the shape of the main verifier's
// VERIFY_TIMEOUT_MS. A call that runs long finalizes on whatever it has.
const ADJUDICATE_TIMEOUT_MS = 3 * 60 * 1000;

// @ref LLP 0011#hard-floors-in-code [implements] — secrets/security can NEVER be cleared by a reply, whatever the config; a code floor `protectedCategories` can only widen, never narrow
/** Categories no reply can ever clear, independent of the configured protected set. */
export const HARD_FLOOR_CATEGORIES: readonly Category[] = ["secrets", "security"];

/**
 * Whether no config — current or future — can ever let a reply clear this finding.
 * `feedbackApplied`'s floor and `adjudicateFeedback`'s "don't spend a model call on it"
 * skip are the same question, so they read it from one place and cannot drift.
 * Deliberately NOT `config.protectedCategories`/`dismiss`: those are user-tunable, so a
 * stored verdict on such a finding becomes useful the moment the config changes.
 */
function hardFloored(finding: Finding): boolean {
  return finding.severity === "critical" || HARD_FLOOR_CATEGORIES.includes(finding.category);
}

/**
 * One record to judge: the finding it answers and the reply's raw text. The reply text
 * is transient adjudicator input — it is built into the prompt and then discarded; it
 * is never stored on the record and never rendered (see FeedbackRecordSchema).
 */
export interface AdjudicationItem {
  finding: Finding;
  record: FeedbackRecord;
  replyText: string;
}

export interface AdjudicationOutcome {
  /** The input records, in the same order, with `verdict`/`reason` filled in where a
   *  call succeeded and `applied` recomputed for every record. */
  records: FeedbackRecord[];
  cost: number;
  tokens: TokenUsage;
  /** provider/model that actually answered the adjudication calls. */
  model?: string;
  /** How many records were judged by a model call this run. */
  adjudicated: number;
  /** Records left unjudged because the per-run cap was hit (never silently). */
  skipped: number;
  /** Records whose model call errored — kept, verdict left unset (fails open). */
  failed: number;
}

// @ref LLP 0011#hard-floors-in-code [constrained-by] — dismissal is gated by `dismiss` alone (default "never"); critical + secrets/security are floored in code, and a prompt-injected verdict can't clear them
/**
 * Whether a reply actually removes this finding from the blocking set. `dismiss` is the
 * one knob that gates clearing — it defaults to "never", so suppression is always an
 * explicit opt-in. `mode` is a separate axis (how much machinery runs), so
 * `dismiss: "maintainers"` works under `mode: "annotate"` with no model involved, the
 * same trust gate as `/dismiss`. NEVER for a critical / secrets / security / protected
 * finding — those floors live here in code, not in any prompt. A maintainer reply that
 * CITES the finding's id clears; the PR author's cited reply clears only under
 * `dismiss: "adjudicated"` with an "accepted" verdict. An untrusted third-party
 * commenter (neither maintainer nor PR author) never clears — its reply is annotated
 * only, as is any reply that merely quotes the finding.
 */
export function feedbackApplied(
  finding: Finding,
  record: FeedbackRecord,
  config: FeedbackConfig,
): boolean {
  if (config.mode === "off" || config.dismiss === "never") {
    return false;
  }
  // @ref LLP 0011#a-quote-annotates-an-id-clears [implements] — a quote may annotate, only a cited id may clear, on BOTH clear paths below
  // A quoted line is not consent: GitHub's "Quote reply" copies a comment the untrusted
  // PR author wrote, so a maintainer can clear-by-accident (or be led to) on text they
  // never authored. The `id:<fp>` token is printed only by our own comment and counts
  // only outside a blockquote, so citing it is an act of the replier.
  if (record.citedId !== true) {
    return false;
  }
  // A human ran `/undismiss` on this reply-cleared finding: it is pinned back to the
  // active list, so the still-present reply must not silently re-clear it.
  if (record.unclearedByHuman) {
    return false;
  }
  if (hardFloored(finding)) {
    return false;
  }
  if (config.protectedCategories.includes(finding.category)) {
    return false;
  }
  if (record.maintainer) {
    return true;
  }
  // The adjudicated path is the PR author's alone. `record.author` is re-derived from
  // the live comment's unspoofable login every run, so a random PR commenter — even
  // with a model-accepted rebuttal — can never clear a finding.
  return (
    config.dismiss === "adjudicated" && record.verdict === "accepted" && record.author === true
  );
}

// @ref LLP 0011#suppression-is-never-silent [implements] — a verdict binds to the source it judged; both merge paths (reporter + aggregate) share THIS predicate so they can never drift apart
/**
 * Strip a stored decision that no longer judges the source under review. A verdict is a
 * claim about CODE, not only about words, and `fingerprintFinding` deliberately excludes
 * the line number, so the author can edit away the code a rebuttal relied on while the
 * finding keeps its identity. Unknown head — no `headSha` for this run, or a record
 * written before the field existed — counts as different, never as trusted. A record
 * with no verdict (a maintainer reply, an unjudged annotation) has no source-dependent
 * decision and passes through untouched. The stale `applied` drops with the verdict:
 * carrying `true` would hide the finding for one render before the recompute.
 */
export function dropStaleVerdict(
  record: FeedbackRecord,
  headSha: string | undefined,
): FeedbackRecord {
  if (record.verdict === undefined || (headSha !== undefined && record.sourceSha === headSha)) {
    return record;
  }
  const { verdict: _verdict, reason: _reason, sourceSha: _sourceSha, ...rest } = record;
  return { ...rest, applied: false };
}

// @ref LLP 0011#hard-floors-in-code [constrained-by] — the extra `gh pr view` runs only where the author flag can move an outcome; a skipped lookup reads exactly like a failed one (author:false, clears nothing)
/**
 * Whether the PR author's login has to be resolved at all for this config. The `author`
 * flag gates exactly one thing — the adjudicated clear path in `feedbackApplied` (and,
 * through it, which replies are worth a model call) — so under any other `dismiss`
 * value resolving it is a `gh` call that can never move an outcome. Absent config (the
 * `ecr feedback` crawl) resolves nothing, which is also the fail-closed answer: an
 * unresolved author marks no reply as the author's and clears nothing.
 */
export function feedbackNeedsPrAuthor(config: FeedbackConfig | undefined): boolean {
  return config?.dismiss === "adjudicated";
}

/**
 * Whether the command layer must wire the runReview feedback seam at all: either a
 * model judges replies ("adjudicate"), or replies may clear findings (`dismiss` opted
 * in) and `applied` must be computed here even though no model runs. Everything else
 * (annotate + never) is handled by the reporter at report time, with no seam.
 */
export function feedbackNeedsRunSeam(config: FeedbackConfig): boolean {
  return config.mode === "adjudicate" || (config.mode !== "off" && config.dismiss !== "never");
}

/**
 * Judge each author reply against the source and record its verdict, then recompute
 * every record's `applied` flag under the hard floors. Bounded: at most
 * `config.maxAdjudications` model calls per run, run in parallel; records past the cap
 * are left unjudged and counted in `skipped` (never silently dropped). Fails open — a
 * model/parse/timeout error on one record keeps it (verdict unset) and never throws.
 * When mode !== "adjudicate" it makes no model calls at all and only recomputes
 * `applied` — under `dismiss: "maintainers"` a maintainer reply still clears without
 * any model; under `dismiss: "never"` nothing does.
 *
 * `sourceSha` is the head commit this run reviewed: every verdict decided here is
 * stamped with it, so a later run can tell whether the verdict still judges the same
 * source (see mergeFeedback). A source with no resolvable head OID (a local run) stamps
 * nothing, which makes the verdict non-carrying rather than permanent.
 */
export async function adjudicateFeedback(
  handle: OpencodeHandle,
  items: AdjudicationItem[],
  config: FeedbackConfig,
  debug: (message: string) => void = () => {},
  sourceSha?: string,
): Promise<AdjudicationOutcome> {
  let cost = 0;
  let model: string | undefined;
  const tokens: TokenUsage = {};
  let failed = 0;

  // Only judge in "adjudicate" mode, and only records without a verdict already decided
  // on a prior run (the reporter carries those forward — re-judging would re-spend the
  // budget on the same words). A reply with no text can't be judged. Only the PR
  // author's replies are worth judging: a maintainer clears without any verdict, and a
  // third-party commenter can never clear (feedbackApplied), so judging either would
  // spend the budget on a rebuttal that changes no outcome. A reply that only quotes the
  // finding can never clear it either, and would otherwise starve a cited reply of the
  // cap. A finding a human already restored via `/undismiss` is likewise left unjudged.
  // A hard-floored finding is skipped for the same reason and is deliberately NOT counted
  // in `skipped` below: that figure means "reduced coverage, raise the cap", and a verdict
  // no config could ever act on is not coverage a higher cap would buy back.
  // @ref LLP 0011#hard-floors-in-code [constrained-by] — the code floor also means the model never judges a critical/secrets/security rebuttal: no verdict could move that outcome
  const toJudge =
    config.mode === "adjudicate"
      ? items.filter(
          (item) =>
            item.record.verdict === undefined &&
            item.record.author === true &&
            item.record.citedId === true &&
            !item.record.unclearedByHuman &&
            !hardFloored(item.finding) &&
            item.replyText.trim() !== "",
        )
      : [];
  // Never truncate silently: the first `maxAdjudications` are judged, the rest are
  // reported as skipped so the caller can surface reduced coverage.
  const within = toJudge.slice(0, config.maxAdjudications);
  const skipped = toJudge.length - within.length;
  if (skipped > 0) {
    debug(
      `Feedback: ${skipped} repl${skipped === 1 ? "y" : "ies"} over ` +
        `maxAdjudications=${config.maxAdjudications} — left unjudged this run.`,
    );
  }

  // A successful call records the verdict against the record it judged; an error leaves
  // it out of the map, so the record below stays untouched (fail open).
  const judged = new Map<FeedbackRecord, { verdict: FeedbackVerdict; reason: FeedbackReason }>();
  await Promise.all(
    within.map(async (item, index) => {
      try {
        const {
          value,
          cost: callCost,
          tokens: callTokens,
          model: callModel,
        } = await promptAndParse(
          handle,
          {
            // Reuse the verifier's OpenCode agent: it carries exactly the read+grep tool
            // set the adjudicator needs (open the cited file, trace the path) and the
            // reviewing model, and its distrust posture matches. The system prompt below
            // is what makes this an adjudication rather than a verification.
            agent: VERIFIER_AGENT,
            system: buildAdjudicatorSystem(),
            text: buildAdjudicatorTask(item.finding, item.replyText),
            title: `adjudicate-${index}`,
            maxWaitMs: ADJUDICATE_TIMEOUT_MS,
            finalizeOnTimeout: true,
          },
          parseAdjudication,
        );
        cost += callCost;
        addTokenUsage(tokens, callTokens);
        model = callModel ?? model;
        judged.set(item.record, { verdict: value.verdict, reason: value.reason });
      } catch (error) {
        // Fail open: an error leaves the record unjudged and the finding intact.
        failed++;
        debug(
          `Feedback: could not adjudicate a reply (${errorMessage(error)}); leaving it unjudged.`,
        );
      }
    }),
  );

  // Re-emit every record: set the verdict/reason where judged, then recompute `applied`
  // under the hard floors (this also clears a maintainer reply, which needs no verdict).
  const records = items.map((item) => {
    const decision = judged.get(item.record);
    // A fresh verdict is stamped with the source it judged (when the run knows it), so
    // the next run re-judges the same reply once that source moves on.
    // @ref LLP 0011#suppression-is-never-silent [implements] — the verdict is bound to the revision it was decided against
    const withVerdict: FeedbackRecord = decision
      ? { ...item.record, verdict: decision.verdict, reason: decision.reason, sourceSha }
      : item.record;
    return { ...withVerdict, applied: feedbackApplied(item.finding, withVerdict, config) };
  });

  return { records, cost, tokens, model, adjudicated: judged.size, skipped, failed };
}
