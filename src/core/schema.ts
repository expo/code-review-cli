// @ref LLP 0005#finding-identity-fingerprints
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
   * Which reviewer agent produced this finding. Engine-populated (never the
   * model); excluded from the fingerprint like `requalifiedBy`, so attribution
   * appearing on a finding can never lapse an existing dismissal.
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

export function parseVerdict(text: string): Verdict {
  return VerdictSchema.parse(extractJsonObject(text));
}

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

export function parseStackVerdict(text: string): StackVerdict {
  return StackVerdictSchema.parse(extractJsonObject(text));
}

/** Shape each sub-reviewer must emit. */
export const ReviewerOutputSchema = z.object({
  findings: z.array(FindingSchema).default([]),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

/** Mode-agnostic coordinator result; each Reporter decides how to render it. */
export const CoordinatorOutputSchema = z.object({
  decision: z.enum(DECISIONS),
  findings: z.array(FindingSchema).default([]),
  summary: z.string(),
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
  verdict: z.enum(FEEDBACK_VERDICTS).optional(),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  /** True when this reply actually removed the finding from the blocking set. */
  applied: z.boolean().default(false),
});
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

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

export function parseAdjudication(text: string): Adjudication {
  return AdjudicationSchema.parse(extractJsonObject(text));
}

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

export function parseRouteOutput(text: string): RouteOutput {
  return RouteOutputSchema.parse(extractJsonObject(text));
}

export function parseReviewerOutput(text: string): ReviewerOutput {
  return ReviewerOutputSchema.parse(extractJsonObject(text));
}

export function parseCoordinatorOutput(text: string): CoordinatorOutput {
  return CoordinatorOutputSchema.parse(extractJsonObject(text));
}
