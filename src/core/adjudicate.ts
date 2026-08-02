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
 * finding — those floors live here in code, not in any prompt. A maintainer reply
 * clears; a plain author reply clears only under `dismiss: "adjudicated"` with an
 * "accepted" verdict.
 */
export function feedbackApplied(
  finding: Finding,
  record: FeedbackRecord,
  config: FeedbackConfig,
): boolean {
  if (config.mode === "off" || config.dismiss === "never") {
    return false;
  }
  if (finding.severity === "critical") {
    return false;
  }
  if (
    HARD_FLOOR_CATEGORIES.includes(finding.category) ||
    config.protectedCategories.includes(finding.category)
  ) {
    return false;
  }
  if (record.maintainer) {
    return true;
  }
  return config.dismiss === "adjudicated" && record.verdict === "accepted";
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
 */
export async function adjudicateFeedback(
  handle: OpencodeHandle,
  items: AdjudicationItem[],
  config: FeedbackConfig,
  debug: (message: string) => void = () => {},
): Promise<AdjudicationOutcome> {
  let cost = 0;
  let model: string | undefined;
  const tokens: TokenUsage = {};
  let failed = 0;

  // Only judge in "adjudicate" mode, and only records without a verdict already decided
  // on a prior run (the reporter carries those forward — re-judging would re-spend the
  // budget on the same words). A reply with no text can't be judged.
  const toJudge =
    config.mode === "adjudicate"
      ? items.filter((item) => item.record.verdict === undefined && item.replyText.trim() !== "")
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
    const withVerdict: FeedbackRecord = decision
      ? { ...item.record, verdict: decision.verdict, reason: decision.reason }
      : item.record;
    return { ...withVerdict, applied: feedbackApplied(item.finding, withVerdict, config) };
  });

  return { records, cost, tokens, model, adjudicated: judged.size, skipped, failed };
}
