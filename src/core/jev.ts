// @ref LLP 0014#active-selective-cascade [implements] — Jev handles narrow judgments and defers uncertainty
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { z } from "zod";

import type { LoadedConfig } from "../config/schema.js";
import type { Finding } from "./schema.js";
import { fingerprintFinding } from "./schema.js";

const TYPESAFE_API_URL = "https://api.typesafe.ai";
const CONCURRENCY = 4;
const MAX_FILE_CHARS = 1_000;
const MAX_TITLE_CHARS = 1_000;
const MAX_RATIONALE_CHARS = 6_000;
const MAX_EVIDENCE_CHARS = 6_000;
const INPUT_COST_PER_MILLION = 0.042;

const SUPPORT_CRITERIA = {
  supported: "The supplied source context directly demonstrates the exact reported problem.",
  needs_reasoning:
    "The context is insufficient, or the claim needs multi-file, runtime, arithmetic, temporal, or indirect reasoning.",
  contradicted:
    "The supplied source context directly demonstrates that the reported problem is not present.",
} as const;

const probability = z.number().min(0).max(1);
const JevResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.object({
    support: z.object({
      type: z.literal("choice"),
      choice: z.enum(["supported", "needs_reasoning", "contradicted"]),
      confidence: probability,
      probabilities: z.object({
        supported: probability,
        needs_reasoning: probability,
        contradicted: probability,
      }),
    }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export interface JevCandidate {
  finding: Finding;
  sourceContext: string;
}

export interface JevEvaluation {
  fingerprint: string;
  model: string;
  support: keyof typeof SUPPORT_CRITERIA;
  confidence: number;
  probabilities: Record<keyof typeof SUPPORT_CRITERIA, number>;
}

export interface JevVerificationSummary {
  configuredModel: string;
  actualModel?: string;
  durationMs: number;
  evaluated: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  unavailable?: string;
}

export interface JevVerificationResult {
  evaluations: Map<string, JevEvaluation>;
  summary: JevVerificationSummary;
}

export interface EvaluateWithJevOptions {
  config: NonNullable<LoadedConfig["jev"]>;
  candidates: readonly JevCandidate[];
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  client?: TypeSafeClient;
}

/** Run a reviewer-engine spawn without exposing the unrelated Jev credential. */
export async function withoutJevCredential<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const apiKey = env.TYPESAFE_API_KEY;
  try {
    delete env.TYPESAFE_API_KEY;
    return await run();
  } finally {
    if (apiKey === undefined) delete env.TYPESAFE_API_KEY;
    else env.TYPESAFE_API_KEY = apiKey;
  }
}

/** Classify candidates with one atomic question; failures become missing evaluations. */
export async function evaluateFindingsWithJev({
  config,
  candidates,
  env = process.env,
  apiKey: explicitApiKey,
  client,
}: EvaluateWithJevOptions): Promise<JevVerificationResult> {
  const started = Date.now();
  const apiKey = (explicitApiKey ?? env.TYPESAFE_API_KEY)?.trim();
  if (!client && !apiKey) return emptyResult(config, started, "TYPESAFE_API_KEY is not set");

  let resolvedClient: TypeSafeClient;
  try {
    resolvedClient =
      client ??
      new TypeSafeClient({
        apiKey,
        baseURL: TYPESAFE_API_URL,
        defaultModel: config.model,
        timeout: config.timeoutMs,
        retry: { maxRetries: 1 },
        logLevel: "off",
      });
  } catch {
    return emptyResult(config, started, "Jev client could not be initialized");
  }

  const evaluations = new Map<string, JevEvaluation>();
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let actualModel: string | undefined;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const candidate = candidates[next++];
      if (!candidate) continue;
      try {
        const response = JevResponseSchema.parse(
          await resolvedClient.systemOne({
            model: config.model,
            state: buildJevState(
              candidate.finding,
              candidate.sourceContext,
              config.maxContextChars,
            ),
            questions: {
              support: choice(
                "Does this source context directly support or contradict this exact code-review finding? Select needs_reasoning whenever the answer depends on omitted context or non-local reasoning.",
                SUPPORT_CRITERIA,
              ),
            },
          }),
        );
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        actualModel = response.model;
        const fingerprint = fingerprintFinding(candidate.finding);
        evaluations.set(fingerprint, {
          fingerprint,
          model: response.model,
          support: response.answers.support.choice,
          confidence: response.answers.support.confidence,
          probabilities: response.answers.support.probabilities,
        });
      } catch {
        failed += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
  );

  return {
    evaluations,
    summary: {
      configuredModel: config.model,
      ...(actualModel ? { actualModel } : {}),
      durationMs: Date.now() - started,
      evaluated: evaluations.size,
      failed,
      inputTokens,
      outputTokens,
      cost: (inputTokens * INPUT_COST_PER_MILLION) / 1_000_000,
    },
  };
}

/** High-confidence local answers act; sensitive or uncertain answers defer. */
export function jevDisposition(
  finding: Finding,
  evaluation: JevEvaluation | undefined,
  minConfidence: number,
): "keep" | "drop" | "defer" {
  if (!evaluation || evaluation.confidence < minConfidence) return "defer";
  // Jev sees repository source, not the audited external passage. The reasoning
  // verifier remains responsible for citation support in either direction.
  if (finding.sources?.length) return "defer";
  if (evaluation.support === "supported") return "keep";
  if (evaluation.support === "needs_reasoning") return "defer";
  if (
    finding.severity === "critical" ||
    finding.category === "security" ||
    finding.category === "secrets"
  ) {
    return "defer";
  }
  return "drop";
}

/** Build the only state sent to TypeSafe: finding metadata plus bounded local source. */
export function buildJevState(finding: Finding, sourceContext: string, maxContextChars: number) {
  return {
    finding: {
      severity: finding.severity,
      category: finding.category,
      file: boundText(finding.file, MAX_FILE_CHARS),
      line: finding.line ?? null,
      title: boundText(finding.title, MAX_TITLE_CHARS),
      rationale: boundText(finding.rationale, MAX_RATIONALE_CHARS),
      evidence: finding.evidence ? boundText(finding.evidence, MAX_EVIDENCE_CHARS) : null,
    },
    sourceContext: boundContext(sourceContext, finding.evidence, maxContextChars),
  };
}

function boundText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function boundContext(context: string, evidence: string | undefined, maxChars: number): string {
  if (context.length <= maxChars) return context;
  const omitted = "\n... source omitted by ecr ...\n";
  const budget = Math.max(1, maxChars - omitted.length);
  const evidenceAt = evidence ? context.indexOf(evidence) : -1;
  if (evidenceAt >= 0) {
    const start = Math.max(0, evidenceAt - Math.floor(budget / 2));
    return context.slice(start, start + budget) + omitted;
  }
  const first = Math.floor(budget / 2);
  const last = budget - first;
  return context.slice(0, first) + omitted + context.slice(-last);
}

function emptyResult(
  config: NonNullable<LoadedConfig["jev"]>,
  started: number,
  unavailable: string,
): JevVerificationResult {
  return {
    evaluations: new Map(),
    summary: {
      configuredModel: config.model,
      durationMs: Date.now() - started,
      evaluated: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      unavailable,
    },
  };
}
