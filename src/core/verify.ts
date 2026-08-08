// @ref LLP 0005#evidence-grounding-escalate-never-hard-drop
// @ref LLP 0005#verifier-confinement-and-fail-open
import { readFile } from "node:fs/promises";
import path from "node:path";

import { pathInside } from "./exec.js";
import type { ResearchEvidence } from "./research.js";
import type { Finding } from "./schema.js";
import { parseVerdict } from "./schema.js";
import { addTokenUsage, promptAndParse, VERIFIER_AGENT } from "./opencode.js";
import type { OpencodeHandle, TokenUsage } from "./opencode.js";
import { buildVerifierSystem, buildVerifierTask } from "./prompts.js";
import type { VerifierCitedSource } from "./prompts.js";
import { errorMessage, normalizeCode } from "./util.js";

// Verification runs after coordination (a serial tail step); keep it short. It
// runs criticals in parallel, so this bounds the added latency regardless of count.
const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;
// Evidence shorter than this (normalized) is too weak to conclude "hallucinated".
const MIN_EVIDENCE_LEN = 12;

export interface VerificationResult {
  kept: Finding[];
  dropped: Array<{ finding: Finding; reason: string }>;
  /**
   * Kept findings whose cited documentation the verifier judged unsupportive.
   * Their `sources` are already removed from `kept`; the caller must also drop
   * the fingerprint-carried copies so a later merge cannot restore them.
   */
  citationStripped: Finding[];
  cost: number;
  tokens: TokenUsage;
  /** provider/model that actually answered the verify calls (see PromptResult.model). */
  model?: string;
}

/** The audited passages behind a finding's grounded citations, bounded per source. */
function citedSourcesFor(
  finding: Finding,
  evidence: ResearchEvidence[],
): VerifierCitedSource[] | undefined {
  if (!finding.sources?.length || evidence.length === 0) return undefined;
  const byUrl = new Map(evidence.map((item) => [item.url, item]));
  const cited = finding.sources.flatMap((source) => {
    const match = byUrl.get(source.url);
    return match ? [{ title: match.title, url: match.url, passage: match.passage }] : [];
  });
  return cited.length > 0 ? cited : undefined;
}

// @ref LLP 0005#evidence-grounding-escalate-never-hard-drop [implements] — exact-substring is a good positive but poor negative signal (33a970a revert)
/**
 * Break `evidence` into normalized, substantive fragments for fuzzy matching:
 * split on newlines AND ellipses (the model often elides with `…`/`...`), strip
 * leading diff markers (`+`/`-`) and comment markers (`//`, `#`, `*`) it may have
 * copied along, normalize, and keep only fragments long enough to be meaningful.
 */
export function evidenceFragments(evidence: string): string[] {
  return evidence
    .split(/\r?\n|…|\.\.\./)
    .map((line) => line.replace(/^[+\-\s]*/, "").replace(/^(\/\/+|#+|\*+|\/\*)\s?/, ""))
    .map(normalizeCode)
    .filter((fragment) => fragment.length >= MIN_EVIDENCE_LEN);
}

/**
 * Does the finding's `evidence` correspond to code in the file?
 *  - exact (whitespace-normalized) substring → 'present'
 *  - else any substantive line/fragment present verbatim → 'present' (fuzzy: this
 *    rescues cross-line quotes, ellipsis elisions, and copied comment/diff markers)
 *  - a real quote that matches nothing → 'absent'
 * Returns 'unknown' (don't judge) when evidence is too short to conclude anything
 * or the file can't be read, so we never drop a finding we couldn't actually check.
 * NOTE: 'absent' is NOT terminal — the caller escalates it to the LLM verifier
 * rather than dropping, because an imperfect quote does not mean a false finding.
 */
export function matchEvidence(evidence: string, content: string): "present" | "absent" | "unknown" {
  const normEvidence = normalizeCode(evidence);
  if (normEvidence.length < MIN_EVIDENCE_LEN) {
    return "unknown";
  }
  const normContent = normalizeCode(content);
  if (normContent.includes(normEvidence)) {
    return "present";
  }
  const fragments = evidenceFragments(evidence);
  if (fragments.length === 0) {
    return "unknown";
  }
  return fragments.some((fragment) => normContent.includes(fragment)) ? "present" : "absent";
}

// @ref LLP 0005#verifier-confinement-and-fail-open [implements] — pathInside gate: out-of-tree reads (and their present/absent verdict) refused
/** Read the cited file and grade the evidence against it (see matchEvidence). */
async function evidencePresence(
  finding: Finding,
  cwd: string,
): Promise<"present" | "absent" | "unknown"> {
  // finding.file is an unconstrained, LLM-authored string produced over untrusted PR
  // content, so a prompt-injected finding could point it at a host secret. path.resolve
  // IGNORES cwd when finding.file is already absolute (e.g. ~/.claude/.credentials.json),
  // and `..` segments escape upward — either would make this raw readFile reach outside
  // the reviewed tree with the host user's privileges, and the present/absent grading
  // would leak a content-oracle back into the review. Confine the read to cwd (the
  // materialized PR-head tree); anything outside is uncheckable, never read.
  const resolved = path.resolve(cwd, finding.file);
  if (!pathInside(resolved, cwd)) {
    return "unknown";
  }
  let content: string;
  try {
    content = await readFile(resolved, "utf8");
  } catch {
    return "unknown";
  }
  return matchEvidence(finding.evidence ?? "", content);
}

// @ref LLP 0005#verifier-confinement-and-fail-open [constrained-by] — fails open: a verify error/timeout keeps the finding, never drops it
/**
 * Guard against hallucinated findings before they're surfaced, WITHOUT silently
 * dropping real ones on an imperfect quote:
 *  1. Quote-grounding (deterministic, all findings): grade each finding's `evidence`
 *     against the file (exact + fuzzy — see matchEvidence).
 *  2. LLM verify (adversarial, in parallel) runs for a finding when EITHER:
 *       - its evidence is `absent` (any severity) — the quote isn't grounded, but
 *         that alone doesn't make the finding false, so the verifier re-reads the
 *         real file (and nearby files) and judges the underlying problem; or
 *       - it's a `critical` (even if grounded) — a skeptical double-check.
 *     A finding is dropped ONLY when the verifier refutes it. `present`/`unknown`
 *     non-criticals are kept without an LLM call (the fast, cheap path).
 * Fails OPEN — if a verify call itself errors, the finding is kept (better a
 * possible false positive than hiding a real finding on an infra hiccup).
 *
 * This replaces the old "absent evidence → hard drop" rule, which was suppressing
 * real findings whose natural evidence (a structural/absence bug, a cross-line
 * quote, a slightly-wrong location) wasn't a verbatim substring.
 */
export async function verifyFindings(
  handle: OpencodeHandle,
  findings: Finding[],
  cwd: string,
  onProgress?: (message: string) => void,
  /** This run's audited research evidence, for findings that cite documentation. */
  researchEvidence: ResearchEvidence[] = [],
): Promise<VerificationResult> {
  const dropped: Array<{ finding: Finding; reason: string }> = [];
  const citationStripped: Finding[] = [];
  // Kept findings the verifier rewrote (currently only citation removal).
  const replacements = new Map<Finding, Finding>();
  let cost = 0;
  let model: string | undefined;
  const tokens: TokenUsage = {};

  // Phase 1 — deterministic quote-grounding for every finding.
  const checked = await Promise.all(
    findings.map(async (finding) => ({ finding, presence: await evidencePresence(finding, cwd) })),
  );

  // Decide which findings need an LLM check vs. can be kept directly. A finding
  // that cites documentation always gets an LLM check: the repo alone cannot
  // confirm an external-behavior claim, and the verifier must judge whether the
  // cited passages support it rather than fall back to model memory.
  const verdicts = new Map<Finding, "keep" | "drop">();
  const toVerify: Array<{
    finding: Finding;
    presence: "present" | "absent" | "unknown";
    citedSources?: VerifierCitedSource[];
  }> = [];
  for (const { finding, presence } of checked) {
    const citedSources = citedSourcesFor(finding, researchEvidence);
    if (presence === "absent" || finding.severity === "critical" || citedSources) {
      toVerify.push({ finding, presence, ...(citedSources ? { citedSources } : {}) });
    } else {
      verdicts.set(finding, "keep"); // grounded (or uncheckable) non-critical
    }
  }

  // Phase 2 — LLM verify (parallel). Refuted → drop; verified or errored → keep.
  await Promise.all(
    toVerify.map(async ({ finding, presence, citedSources }, index) => {
      try {
        const {
          value,
          cost: verifyCost,
          tokens: verifyTokens,
          model: verifyModel,
        } = await promptAndParse(
          handle,
          {
            agent: VERIFIER_AGENT,
            system: buildVerifierSystem(),
            text: buildVerifierTask(finding, {
              evidenceUngrounded: presence === "absent",
              ...(citedSources ? { citedSources } : {}),
            }),
            title: `verify-${index}`,
            maxWaitMs: VERIFY_TIMEOUT_MS,
            finalizeOnTimeout: true,
            onActivity: (line) => onProgress?.(`  [verifier] #${index + 1}: ${line}`),
          },
          parseVerdict,
        );
        cost += verifyCost;
        addTokenUsage(tokens, verifyTokens);
        model = verifyModel ?? model;
        if (value.verified) {
          verdicts.set(finding, "keep");
          // An explicit false strips the citation; the finding itself stands.
          // Absent or true leaves the grounded sources untouched (fail open).
          if (citedSources && value.citationSupported === false) {
            const { sources: _sources, ...withoutSources } = finding;
            replacements.set(finding, withoutSources);
            citationStripped.push(finding);
            onProgress?.(
              `  verify: kept "${finding.title}" but removed its citation — the cited passages do not support the claim`,
            );
          }
        } else {
          verdicts.set(finding, "drop");
          dropped.push({ finding, reason: value.reason || "refuted by verifier" });
          onProgress?.(
            `  verify: dropped ${finding.severity} "${finding.title}" — ${value.reason || "refuted by verifier"}`,
          );
        }
      } catch (error) {
        // Fail open: keep the finding if verification itself failed.
        verdicts.set(finding, "keep");
        onProgress?.(
          `  verify: could not verify "${finding.title}" (${errorMessage(error)}); keeping it`,
        );
      }
    }),
  );

  // Preserve original order.
  const kept = findings
    .filter((finding) => verdicts.get(finding) === "keep")
    .map((finding) => replacements.get(finding) ?? finding);
  return { kept, dropped, citationStripped, cost, tokens, model };
}
