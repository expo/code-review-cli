// @ref LLP 0005#finding-identity-fingerprints
// @ref LLP 0013#research-provenance-and-citations [implements] — optional citations are annotations, not finding identity or decision inputs
import { createHash } from "node:crypto";

import { z } from "zod";

import { normalizeCode } from "./util.js";

/** Severity levels, ordered most→least severe for sorting/rendering. */
export const SEVERITIES = ["critical", "warning", "suggestion"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Sort rank for severities (0 = most severe). Single source of truth. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2 };

export const CATEGORIES = ["correctness", "quality", "security", "secrets"] as const;
export type Category = (typeof CATEGORIES)[number];

export const DECISIONS = ["approve", "approve_with_comments", "request_changes"] as const;
export type Decision = (typeof DECISIONS)[number];

export const FindingSourceSchema = z.object({
  title: z.string().min(1).max(240),
  url: z
    .string()
    .url()
    .max(2_000)
    .refine((value) => new URL(value).protocol === "https:", "source URL must use HTTPS"),
});
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const RESEARCH_DECISION_OUTCOMES = ["supported-finding", "dismissed-candidate"] as const;

/**
 * A reviewer-declared decision that documentation materially changed. Sources are
 * later grounded against the MCP audit exactly like finding citations; an ungrounded
 * record is discarded and can never inflate usefulness metrics.
 */
export const ResearchDecisionSchema = z.object({
  outcome: z.enum(RESEARCH_DECISION_OUTCOMES),
  summary: z.string().min(1).max(240),
  sources: z.array(FindingSourceSchema).min(1).max(5),
});
export type ResearchDecision = z.infer<typeof ResearchDecisionSchema>;

/** A single unit of changed code, produced by a ReviewSource. */
export interface DiffEntry {
  /** Path relative to the repo root, in the new tree. */
  path: string;
  /** Unified-diff patch text for this file. */
  patch: string;
  /** git status letter (A/M/D/R...) when the source can provide it. */
  status?: string;
  /**
   * True when git emitted a binary-diff marker ("Binary files ... differ") for
   * this file instead of a textual patch. Such an entry has no reviewable diff
   * content, so it is filtered as noise rather than handed to an agent.
   */
  binary?: boolean;
}

export interface ReviewMetadata {
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  /**
   * Immutable commit OIDs for the PR's base and head, when the source can resolve
   * them (GitHub PRs). Materialization pins to these — never to branch names —
   * so a rename/force-push between API calls can't swap the reviewed tree.
   */
  baseOid?: string;
  headOid?: string;
}

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  file: z.string(),
  line: z.number().int().nullable().optional().default(null),
  title: z.string(),
  rationale: z.string(),
  suggestion: z.string().optional(),
  sources: z
    .array(FindingSourceSchema)
    .max(5)
    .optional()
    .describe(
      "Exact documentation sources used to support this finding; copy the returned title and canonical URL from this review's MCP results and omit when unused",
    ),
  /**
   * Verbatim snippet of the flagged code, copied from the file. Used to
   * quote-ground the finding: if this text isn't actually present in the file,
   * the finding is treated as hallucinated and dropped.
   */
  evidence: z.string().optional(),
  /**
   * Set by the coordinator (and then ground-checked, see groundStackRequalification)
   * when a later, stacked-on-top PR already addresses this absence-style finding:
   * `prNumber` + the EXACT upstack manifest `file` relied on + a one-line `reason`.
   * A requalified finding is never dropped — it renders in its own section, is
   * counted, and is only excluded from the blocking decision. Never part of the
   * fingerprint, so dismissal identity is stable across re-reviews.
   */
  // @ref LLP 0010#requalification-schema-and-fingerprints [constrained-by] — annotate-only; excluded from fingerprintFinding so dismissal identity never lapses on requalification
  requalifiedBy: z
    .object({ prNumber: z.number().int(), file: z.string(), reason: z.string() })
    .optional(),
  /**
   * Which reviewer agent produced this finding. Engine-populated, never the model:
   * `ModelFindingSchema` omits it, so an `agent` in model JSON is dropped at the parse
   * boundary and only the engine's fingerprint lookup can set it. Excluded from the
   * fingerprint like `requalifiedBy`, so attribution appearing on a finding can never
   * lapse an existing dismissal.
   */
  // @ref LLP 0011#attribution-and-identity [constrained-by] — attribution is annotation-only; never part of fingerprintFinding
  agent: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * Title of the internal "overall PR risk" handoff finding. The cross-cutting
 * reviewer (or the always-run security reviewer on a PR small enough to skip the
 * cross-cutting pass) rides the ordinary finding channel to hand the coordinator
 * a whole-PR risk assessment — see the "Overall PR risk handoff" section in
 * `templates/shared.md`. It is prompt-level metadata, never a defect.
 */
// @ref LLP 0009#prompt-rules-for-adopters [implements] — the deterministic strip that makes the handoff independent of policy.includeSuggestions
export const OVERALL_PR_RISK_TITLE = "__overall_pr_risk__";

/**
 * Is this the internal risk handoff rather than a real finding? Matched on the
 * exact title the prompt specifies. Reported findings must never include it: it
 * would surface to PR authors as a nonsense bullet, and it is not a defect.
 */
export function isOverallRiskHandoff(finding: Finding): boolean {
  return finding.title.trim() === OVERALL_PR_RISK_TITLE;
}

/** A verifier's verdict on whether a finding is real (adversarial refute pass). */
export const VerdictSchema = z.object({
  verified: z.boolean(),
  reason: z.string().default(""),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A stack verifier's verdict on whether a later stacked PR's patch actually
 * addresses an absence-style finding (v2 patch confirmation). Fails toward
 * blocking: anything but a clear `addressed: true` strips the requalification.
 */
// @ref LLP 0010#patch-level-confirmation-v2 [constrained-by] — addressed !== true keeps the finding blocking
export const StackVerdictSchema = z.object({
  addressed: z.boolean(),
  reason: z.string().default(""),
});
export type StackVerdict = z.infer<typeof StackVerdictSchema>;

// @ref LLP 0011#attribution-and-identity [implements] — `agent` is engine-populated, so the model-facing schema drops it at the parse boundary instead of trusting call sites to strip it
/**
 * The finding shape a MODEL may emit: `FindingSchema` minus the engine-only `agent`.
 * Both model outputs parse through this, so an `agent` a reviewer pass or the
 * coordinator invented is dropped where model JSON becomes typed data — the engine's own
 * fingerprint lookup is then the only thing that can set it. This schema deliberately
 * has no Zod transform: the Claude runtime converts it to JSON Schema so the provider
 * can enforce the same contract before the local parse boundary checks it again.
 */
const ModelFindingSchema = FindingSchema.omit({ agent: true });

/**
 * Bounded, non-finding diagnostics a reviewer may leave for machine consumers.
 * These notes explain what a clean pass actually checked without exposing a raw
 * transcript or chain-of-thought. They remain unverified model output, so the
 * engine labels the assembled trace with an explicit trust classification.
 */
export const REVIEW_TRACE_AGENT_LIMIT = 12;
export const REVIEW_TRACE_CHECKED_LIMIT = 3;
export const REVIEW_TRACE_UNCERTAINTY_LIMIT = 2;
export const REVIEW_TRACE_NOTE_LIMIT = 240;
export const REVIEW_TRACE_BYTES_LIMIT = 6_000;

export const ReviewerTraceNotesSchema = z.object({
  checked: z
    .array(z.string().min(1).max(REVIEW_TRACE_NOTE_LIMIT))
    .max(REVIEW_TRACE_CHECKED_LIMIT)
    .default([]),
  uncertainties: z
    .array(z.string().min(1).max(REVIEW_TRACE_NOTE_LIMIT))
    .max(REVIEW_TRACE_UNCERTAINTY_LIMIT)
    .default([]),
});
export type ReviewerTraceNotes = z.infer<typeof ReviewerTraceNotesSchema>;

/** Provider-facing shape each sub-reviewer is asked to emit. */
const ReviewerModelOutputSchema = z.object({
  findings: z.array(ModelFindingSchema).default([]),
  trace: ReviewerTraceNotesSchema.optional(),
  researchDecisions: z.array(ResearchDecisionSchema).max(8).optional(),
});

/**
 * Local trust boundary for reviewer output. Findings stay strict, while diagnostics
 * fail soft: a malformed optional trace must never discard otherwise valid findings
 * or turn a clean pass into a coverage gap.
 */
export const ReviewerOutputSchema = z
  .object({
    findings: z.array(ModelFindingSchema).default([]),
    trace: z.unknown().optional(),
    researchDecisions: z.unknown().optional(),
  })
  .transform((output) => {
    const trace = ReviewerTraceNotesSchema.safeParse(output.trace);
    const researchDecisions = z
      .array(ResearchDecisionSchema)
      .max(8)
      .safeParse(output.researchDecisions);
    return {
      findings: output.findings,
      ...(trace.success ? { trace: trace.data } : {}),
      ...(researchDecisions.success ? { researchDecisions: researchDecisions.data } : {}),
    };
  });
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export const ReviewTraceSchema = z.object({
  version: z.literal(1),
  trust: z.literal("unverified-model-diagnostics"),
  agents: z.record(z.string(), ReviewerTraceNotesSchema),
  truncatedAgents: z.number().int().nonnegative().optional(),
});
export type ReviewTrace = z.infer<typeof ReviewTraceSchema>;

/** Mode-agnostic coordinator result; each Reporter decides how to render it. */
const CoordinatorModelOutputSchema = z.object({
  decision: z.enum(DECISIONS),
  findings: z.array(ModelFindingSchema).default([]),
  summary: z.string(),
});

export const CoordinatorOutputSchema = CoordinatorModelOutputSchema.extend({
  /**
   * Human-readable notes about reduced coverage (e.g. a review pass that hit its
   * time limit and returned partial findings, or was skipped). Populated by the
   * engine after coordination, not by the model. Reporters surface these so a
   * cut-short review is never presented as complete.
   */
  incomplete: z.array(z.string()).default([]),
  /**
   * True when EVERY pass failed — nothing was actually reviewed. Set by the
   * engine, never the model. Reporters must not render an approving decision
   * label for such a run (the decision enum has no "no review" member, and
   * widening it would ripple through dismiss state and exit codes — this flag
   * overrides the presentation instead).
   */
  couldNotComplete: z.boolean().optional(),
  /**
   * Advice about the review's OWN setup: refs in `.expo-code-review/` that no longer
   * resolve, and cited code this PR changes. Engine-set (never the model, never a
   * finding) and never blocking — a stale prompt is a maintenance signal, not a defect
   * in the PR.
   */
  // @ref LLP 0012#run-points-command-and-review [implements] — the review advises about stale refs instead of failing on them
  // Optional (like couldNotComplete) so every internal CoordinatorOutput literal stays
  // valid without restating an engine-owned field.
  setupNotes: z.array(z.string()).optional(),
  /**
   * Machine-readable reviewer diagnostics embedded in the hidden PR-comment state.
   * Engine-owned and excluded from the coordinator's provider-side schema. It is not
   * rendered as prose and must never affect the decision or finding set.
   */
  // Fail soft here too: the coordinator cannot author this engine field, and a
  // malformed injected value must not fail consolidation before the engine strips it.
  reviewTrace: ReviewTraceSchema.optional().catch(undefined),
});
export type CoordinatorOutput = z.infer<typeof CoordinatorOutputSchema>;

/** A per-PR dismissal ("I don't care about this finding"), keyed by fingerprint. */
export interface DismissalRecord {
  fp: string;
  by?: string;
  reason?: string;
}

/** How an author's reply to a finding held up against the source. */
export const FEEDBACK_VERDICTS = ["accepted", "refuted", "unclear"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

/** The kinds of pushback authors actually write, as a closed set. */
export const FEEDBACK_REASONS = [
  "pre-existing", // the PR only continues a pattern already in the repo
  "deliberate-scope", // a bounded, intentional limitation of new code
  "fixed", // the author says they addressed it
  "disagree", // the author disputes the analysis itself
  "other",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

// @ref LLP 0011#never-echo-reply-text [constrained-by] — no free-text field: reply prose never reaches the comment body, so it can never carry a forged state marker
/**
 * One author reply matched to one finding, keyed by fingerprint. Everything here
 * is either engine-derived or enum-valued — deliberately NO free-text field. The
 * reply's own prose is never stored and never rendered; adding a field for it
 * would put attacker-written text back into the comment body.
 */
export const FeedbackRecordSchema = z.object({
  fp: z.string(),
  by: z.string(),
  commentId: z.number().int(),
  url: z.string().optional(),
  maintainer: z.boolean().default(false),
  /**
   * True when the replying login is the PR author. Re-derived from the live comment
   * every run (never trusted from stored state), so it is unspoofable like `maintainer`.
   * Only a maintainer OR the PR author may clear a finding via a reply — an untrusted
   * third-party commenter is annotated but can never be counted as an adjudicatable
   * rebuttal (feedbackApplied gates the adjudicated path on this).
   */
  // @ref LLP 0011#hard-floors-in-code [constrained-by] — the adjudicated clear path is for the PR author only; a third-party commenter's rebuttal never clears
  author: z.boolean().optional(),
  /**
   * True when the reply cites this finding's `id:<fp>` token in the replier's OWN words
   * (outside every blockquote). Re-derived from the live comment every run by
   * `matchReplies`, never trusted from stored state, exactly like `maintainer`/`author`.
   * A quote-only match still ANNOTATES the finding; only a cited id may CLEAR it, on
   * both clear paths. Absent ⇒ false ⇒ clears nothing, so a record written before this
   * field parses fine and fails closed until its reply is matched again.
   */
  // @ref LLP 0011#a-quote-annotates-an-id-clears [constrained-by] — a quoted line can be text the untrusted PR author planted for a maintainer to quote-reply, so a quote may annotate but never clear
  citedId: z.boolean().optional(),
  verdict: z.enum(FEEDBACK_VERDICTS).optional(),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  /**
   * The reviewed head commit the verdict above was judged against (the PR head OID of
   * the run whose adjudicator answered). A verdict is a statement about SOURCE, and a
   * fingerprint deliberately excludes the line number, so a finding keeps its identity
   * while the code that justified the rebuttal is edited away. Binding the verdict to
   * the revision it judged is what lets mergeFeedback drop it once the head moves.
   * Absent ⇒ unknown source (a record from before this field, or a run with no
   * resolvable head OID): the verdict never carries, so a missing SHA can never pin a
   * decision forever.
   */
  // @ref LLP 0011#suppression-is-never-silent [constrained-by] — a carried verdict must be re-judged when the source it judged changes; unknown source fails safe to re-judging
  sourceSha: z.string().optional(),
  /** True when this reply actually removed the finding from the blocking set. */
  applied: z.boolean().default(false),
  /**
   * Set when a human ran `/undismiss <id>` on a finding a reply had cleared: the
   * finding returns to the active list and no live reply may re-apply it, so a later
   * re-review recomputing `applied` from the still-present reply keeps it un-cleared.
   *
   * DERIVED, never the storage: the pin itself lives in the comment state's own `pins`
   * set (see FeedbackPinSchema), which survives a run where no reply matches the
   * finding at all. This flag is stamped back onto the record by `applyPins` on every
   * render so `feedbackApplied` stays a pure record-local decision — and so a comment
   * written by this version is still read correctly by an older one.
   */
  // @ref LLP 0011#suppression-is-never-silent [constrained-by] — /undismiss must actually restore a reply-cleared finding, and the untrusted PR author must not be able to lift that restore by removing or replacing their reply
  unclearedByHuman: z.boolean().optional(),
});
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

// @ref LLP 0011#the-pin-belongs-to-the-finding [implements] — the pin is state about a FINDING, stored outside the reply record so a vanishing reply can never drop it
/**
 * One maintainer `/undismiss` pin: the finding they restored, plus the reply comment
 * the pin was applied against (absent when the finding had no reply record). The
 * comment id is what makes "a maintainer's own NEWER reply lifts the pin" decidable
 * without the pin having to live on a reply record: only a maintainer reply posted
 * AFTER the pin (a strictly greater comment id — GitHub issue comment ids increase)
 * releases it.
 */
export const FeedbackPinSchema = z.object({
  fp: z.string(),
  commentId: z.number().int().optional(),
});
export type FeedbackPin = z.infer<typeof FeedbackPinSchema>;

/**
 * The pin set to work with: the state's own `pins` plus any record-level
 * `unclearedByHuman` flag. The second half is the migration for a comment written
 * before `pins` existed — its pins live only on the records, and dropping them would
 * silently lift a maintainer's restore on the first render by this version. Idempotent.
 */
export function collectPins(
  pins: FeedbackPin[] | undefined,
  records: FeedbackRecord[],
): FeedbackPin[] {
  const byFp = new Map<string, FeedbackPin>();
  for (const pin of pins ?? []) {
    byFp.set(pin.fp, pin);
  }
  for (const record of records) {
    if (record.unclearedByHuman === true && !byFp.has(record.fp)) {
      byFp.set(record.fp, { fp: record.fp, commentId: record.commentId });
    }
  }
  return [...byFp.values()];
}

// @ref LLP 0011#the-pin-belongs-to-the-finding [implements] — the pin set is the single source of truth; the record flag is stamped from it, never the other way round
/**
 * Carry the pin set across one render and stamp the records it covers. A pinned
 * record can never be `applied` (the finding stays in the active list), and a record
 * the set does NOT pin loses any stale flag — the set decides, so a flag left on a
 * record could never resurrect a lifted pin.
 *
 * The only lift here is a maintainer's own newer reply: a reply record for the pinned
 * finding, from a maintainer, posted after the pin. Everything else (a newer reply from
 * the untrusted PR author, an edited or deleted reply, a re-review that matched no
 * reply at all) leaves the pin exactly where it is. The other lift — a maintainer's
 * `/dismiss` on that finding — happens in applyDismissalToState, the same trusted hand
 * deciding the opposite way.
 */
export function applyPins(
  records: FeedbackRecord[],
  pins: FeedbackPin[],
): { records: FeedbackRecord[]; pins: FeedbackPin[] } {
  const kept = pins.filter(
    (pin) =>
      // A pin with no recorded commentId is never lifted by a reply: "unknown" must not
      // read as "older than every comment", which would let any maintainer reply lift it.
      pin.commentId === undefined ||
      !records.some(
        (record) =>
          record.fp === pin.fp && record.maintainer === true && record.commentId > pin.commentId!,
      ),
  );
  const pinnedFps = new Set(kept.map((pin) => pin.fp));
  const stamped = records.map((record) => {
    if (pinnedFps.has(record.fp)) {
      return { ...record, unclearedByHuman: true, applied: false };
    }
    if (record.unclearedByHuman === undefined) {
      return record;
    }
    const { unclearedByHuman: _lifted, ...rest } = record;
    return rest;
  });
  return { records: stamped, pins: kept };
}

/**
 * The adjudicator's verdict on one rebuttal, re-derived from the source. Both
 * fields are enum-constrained: the judgment is a classification, never prose the
 * model could smuggle instructions (or a state marker) through.
 */
export const AdjudicationSchema = z.object({
  verdict: z.enum(FEEDBACK_VERDICTS),
  reason: z.enum(FEEDBACK_REASONS).default("other"),
});
export type Adjudication = z.infer<typeof AdjudicationSchema>;

/** Minimum normalized evidence length to key a fingerprint on the code (below
 * this we fall back to the title). */
const MIN_FP_EVIDENCE_LEN = 12;

// @ref LLP 0005#finding-identity-fingerprints [implements] — keys on evidence (v2) not the LLM-written title; excludes line number
/**
 * Stable identifier for a finding — dedupes across re-reviews and is the key for
 * dismissals. Excludes the line number (which shifts as a PR grows). Keys on the
 * verbatim `evidence` snippet (v2) rather than the LLM-written `title`, which
 * varies run-to-run and would make a dismissal silently lapse. When the flagged
 * code later changes, the hash changes and the dismissal lapses — which is correct
 * (you dismissed that code, not a blank check). Falls back to `title` only when
 * there's too little evidence to key on.
 */
export function fingerprintFinding(finding: Finding): string {
  const evidence = normalizeCode(finding.evidence ?? "");
  const key = evidence.length >= MIN_FP_EVIDENCE_LEN ? evidence : normalizeCode(finding.title);
  const normalized = ["v2", finding.file, finding.category, key].join("|");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

// @ref LLP 0005#finding-identity-fingerprints [implements] — default scope passes null so pre-routing dismissals still resolve (risk 9)
/**
 * Namespace a finding's fingerprint by scope so cross-scope dismissals never
 * collide. The DEFAULT scope (config '.') passes `null` and keeps the plain
 * fingerprintFinding value, so pre-routing dismissal state carries over unchanged
 * (risk 9). Non-default scopes hash into the same hex alphabet the dismiss command
 * sanitizes to (dismiss.ts strips /[^a-f0-9]/), at the same length.
 */
export function scopedFingerprint(scopeName: string | null, finding: Finding): string {
  const fp = fingerprintFinding(finding);
  if (!scopeName) {
    return fp;
  }
  return createHash("sha1").update(`scope|${scopeName}|${fp}`).digest("hex").slice(0, fp.length);
}

/**
 * Extract the JSON payload from an LLM response. Prefers the last fenced
 * ```json block; falls back to the outermost {...} span. Throws if neither
 * parses.
 */
export function extractJsonObject(text: string): unknown {
  const fenceMatches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  const candidates: string[] = [];
  if (fenceMatches.length > 0) {
    candidates.push(fenceMatches[fenceMatches.length - 1]![1]!.trim());
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    lastError === undefined
      ? // No candidate was even tried: the response held no {...} block at all —
        // empty output, or prose/pseudo-tool-call text with no JSON in it.
        `Could not extract JSON from model response: no JSON object found in ` +
          `${text.trim() === "" ? "an EMPTY response" : `a ${text.length}-char response with no {...}`}`
      : `Could not extract JSON from model response: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
  );
}

/** The router's choice of which agent ids to run. */
export const RouteOutputSchema = z.object({
  agents: z.array(z.string()).default([]),
});
export type RouteOutput = z.infer<typeof RouteOutputSchema>;

type JsonSchema = Record<string, unknown>;
type StructuredParser<T> = ((text: string) => T) & { jsonSchema: JsonSchema };

/**
 * Bind local Zod validation to the draft-07 JSON Schema Claude Code consumes.
 * Local parsing remains authoritative; provider-side validation is a reliability
 * layer that repairs malformed output before it reaches this trust boundary.
 */
// @ref LLP 0003#retry-taxonomy [implements] — Claude receives the same contract as the local parser and repairs mismatches in-session
function structuredParser<T>(
  parseSchema: z.ZodType<T>,
  outputSchema: z.ZodType = parseSchema,
): StructuredParser<T> {
  const parser = ((text: string): T =>
    parseSchema.parse(extractJsonObject(text))) as StructuredParser<T>;
  parser.jsonSchema = z.toJSONSchema(outputSchema, { target: "draft-7" }) as JsonSchema;
  return parser;
}

export const parseVerdict = structuredParser(VerdictSchema);
export const parseStackVerdict = structuredParser(StackVerdictSchema);
export const parseAdjudication = structuredParser(AdjudicationSchema);
export const parseRouteOutput = structuredParser(RouteOutputSchema);
export const parseReviewerOutput = structuredParser(
  ReviewerOutputSchema,
  ReviewerModelOutputSchema,
);
export const parseCoordinatorOutput = structuredParser(
  CoordinatorOutputSchema,
  CoordinatorModelOutputSchema,
);
