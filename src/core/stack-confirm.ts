// @ref LLP 0010#patch-level-confirmation-v2 [implements] — path membership is not semantic proof; read the addressing patch, fail toward keeping the finding blocking
import { addTokenUsage, promptAndParse, STACK_VERIFIER_AGENT } from "./opencode.js";
import type { OpencodeHandle, TokenUsage } from "./opencode.js";
import { buildStackVerifierSystem, buildStackVerifierTask } from "./prompts.js";
import { fingerprintFinding, parseStackVerdict } from "./schema.js";
import type { Finding } from "./schema.js";
import { manifestKey } from "./stack.js";
import type { ReviewSource } from "../sources/source.js";
import { errorMessage } from "./util.js";

// Confirmation runs after coordination (a serial tail step), in parallel over unique
// candidates. A confirmation that runs long is stripped (fail toward blocking), so this
// timeout is a hard "give up and keep the finding" bound, not a retry trigger.
const STACK_CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

/** One candidate to confirm: a cited `(prNumber, file)` and the finding relying on it. */
export interface Candidate {
  prNumber: number;
  file: string;
  finding: Finding;
}

/** A single candidate's confirmation outcome, plus its spend for run metrics. */
export interface CandidateConfirmation {
  addressed: boolean;
  cost: number;
  tokens: TokenUsage;
  model?: string;
}

/** Confirm ONE candidate. Any rejection is signalled by `addressed: false`; any error
 * (fetch failure, timeout, parse failure) MUST throw so the caller strips (fail-open
 * toward blocking). */
export type ConfirmOne = (candidate: Candidate) => Promise<CandidateConfirmation>;

export interface StackConfirmationResult {
  findings: Finding[];
  /** How many requalifications the confirmation stripped (returned to blocking). */
  stripped: number;
  /** The stripped requalifications with their strip reason, for the run-log audit
   * trail (the caller merges them with grounding's strips). */
  strippedFindings: { finding: Finding; reason: string }[];
  cost: number;
  tokens: TokenUsage;
  model?: string;
}

// @ref LLP 0010#patch-level-confirmation-v2 [constrained-by] — one verdict PER FINDING (only the patch fetch is shared); overflow past maxConfirmations is STRIPPED, not skipped; addressed!==true / error / timeout all STRIP
/**
 * Confirm every surviving requalification against the addressing PR's real patch and
 * strip any that is not clearly addressed. Pure orchestration over an injected
 * `confirmOne` so the per-finding / overflow / fail-open logic is unit-testable
 * without gh or a live model:
 *  - every requalified finding gets its OWN verdict — the verdict question is
 *    finding-specific ("does this patch supply what THIS finding says is missing"),
 *    so a shared verdict would let one confirmed finding clear an unrelated one
 *    citing the same `(prNumber, file)`. Only the patch FETCH is shared (memoized in
 *    `patchConfirmer`); identical findings (same fingerprint + citation) collapse;
 *  - only the first `maxConfirmations` candidates are confirmed — any beyond that
 *    cap have their requalification STRIPPED (fail toward blocking), never silently
 *    kept;
 *  - a candidate is kept ONLY on `addressed === true`; `false`, any thrown error, or a
 *    timeout strips it.
 * A stripped requalification leaves the finding fully intact and blocking.
 */
export async function confirmStackRequalifications(
  findings: Finding[],
  maxConfirmations: number,
  confirmOne: ConfirmOne,
  debug: (message: string) => void = () => {},
): Promise<StackConfirmationResult> {
  // One candidate per requalified finding, in first-seen order. The key pairs the
  // citation with the finding's fingerprint so only true duplicates share a verdict.
  const candidateKey = (finding: Finding, prNumber: number, file: string): string =>
    `${manifestKey(prNumber, file)}|${fingerprintFinding(finding)}`;
  const candidates = new Map<string, Candidate>();
  for (const finding of findings) {
    const requalified = finding.requalifiedBy;
    if (!requalified) {
      continue;
    }
    const key = candidateKey(finding, requalified.prNumber, requalified.file);
    if (!candidates.has(key)) {
      candidates.set(key, { prNumber: requalified.prNumber, file: requalified.file, finding });
    }
  }

  const keys = [...candidates.keys()];
  const withinCap = new Set(keys.slice(0, maxConfirmations));
  const overflow = keys.slice(maxConfirmations);
  // Per-candidate strip reason, for the run-log audit trail the caller persists.
  const stripReasons = new Map<string, string>();
  for (const key of overflow) {
    stripReasons.set(key, `over maxConfirmations=${maxConfirmations} — stripped unconfirmed`);
  }
  if (overflow.length > 0) {
    debug(
      `Stack: ${overflow.length} requalification(s) over maxConfirmations=${maxConfirmations} — stripped unconfirmed.`,
    );
  }

  // Confirm the within-cap candidates in parallel; each call is independently guarded.
  const addressed = new Set<string>();
  let cost = 0;
  let model: string | undefined;
  const tokens: TokenUsage = {};
  await Promise.all(
    [...withinCap].map(async (key) => {
      const candidate = candidates.get(key)!;
      try {
        const result = await confirmOne(candidate);
        cost += result.cost;
        addTokenUsage(tokens, result.tokens);
        model = result.model ?? model;
        if (result.addressed) {
          addressed.add(key);
        } else {
          stripReasons.set(key, "patch does not address it");
          debug(
            `Stack: stripped requalification on "${candidate.finding.file}" (patch does not address it).`,
          );
        }
      } catch (error) {
        // Fail toward blocking: a fetch/verify error keeps the finding blocking.
        stripReasons.set(key, `confirmation failed: ${errorMessage(error)}`);
        debug(
          `Stack: stripped requalification on "${candidate.finding.file}" (confirmation failed: ${errorMessage(error)}).`,
        );
      }
    }),
  );

  let stripped = 0;
  const strippedFindings: { finding: Finding; reason: string }[] = [];
  const out = findings.map((finding) => {
    const requalified = finding.requalifiedBy;
    if (!requalified) {
      return finding;
    }
    const key = candidateKey(finding, requalified.prNumber, requalified.file);
    if (addressed.has(key)) {
      return finding;
    }
    stripped++;
    const { requalifiedBy: _dropped, ...rest } = finding;
    strippedFindings.push({ finding: rest, reason: stripReasons.get(key) ?? "not confirmed" });
    return rest;
  });
  return { findings: out, stripped, strippedFindings, cost, tokens, model };
}

// @ref LLP 0010#patch-level-confirmation-v2 [implements] — real confirmer: fetch just the cited file's patch (fail-open null → strip), inline it into the no-tools stack verifier
/**
 * Build the real per-candidate confirmer: fetch just the cited file's patch from the
 * addressing PR (the source fails open to `null` → treated as "not addressed"), inline
 * it into the no-tools stack verifier, and require `addressed: true`. The patch is
 * inlined, never materialized — there is no disk read and no tool use at all.
 */
export function patchConfirmer(handle: OpencodeHandle, source: ReviewSource): ConfirmOne {
  // Per-run patch memo: distinct findings citing the same (prNumber, file) each get
  // their own verdict but share one gh fetch. The source fails open to null (never
  // rejects), so memoizing the promise is safe.
  const patches = new Map<string, Promise<string | null>>();
  return async ({ prNumber, file, finding }) => {
    const patchKey = manifestKey(prNumber, file);
    let patchPromise = patches.get(patchKey);
    if (!patchPromise) {
      patchPromise = source.getStackFilePatchAsync
        ? source.getStackFilePatchAsync(prNumber, file)
        : Promise.resolve(null);
      patches.set(patchKey, patchPromise);
    }
    const patch = await patchPromise;
    if (patch == null) {
      // No patch for the cited file (or the source can't fetch it): not confirmable.
      return { addressed: false, cost: 0, tokens: {} };
    }
    const { value, cost, tokens, model } = await promptAndParse(
      handle,
      {
        agent: STACK_VERIFIER_AGENT,
        system: buildStackVerifierSystem(),
        text: buildStackVerifierTask(finding, prNumber, patch),
        title: `stack-verify-${prNumber}`,
        maxWaitMs: STACK_CONFIRM_TIMEOUT_MS,
        // A timeout here throws AgentTimeoutError, which the caller catches and STRIPS
        // (fail toward blocking) — so no finalize salvage, unlike the main verifier.
        finalizeOnTimeout: false,
      },
      parseStackVerdict,
    );
    return { addressed: value.addressed === true, cost, tokens, model };
  };
}
