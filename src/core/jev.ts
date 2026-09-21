// @ref LLP 0014#shadow-first-integration [implements] — Jev records a bounded second opinion without entering the decision path
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { z } from "zod";

import type { LoadedConfig } from "../config/schema.js";
import type { DiffEntry, Finding } from "./schema.js";
import { fingerprintFinding } from "./schema.js";

const TYPESAFE_API_URL = "https://api.typesafe.ai";
const CONCURRENCY = 4;
const MAX_FILE_CHARS = 1_000;
const MAX_TITLE_CHARS = 1_000;
const MAX_RATIONALE_CHARS = 6_000;
const MAX_EVIDENCE_CHARS = 6_000;

const SUPPORT_CRITERIA = {
  supported: "The supplied patch contains concrete evidence for the reported problem.",
  insufficient: "The supplied patch does not contain enough evidence to decide.",
  contradicted: "The supplied patch shows that the reported problem is not present.",
} as const;

const SEVERITY_CRITERIA = {
  suggestion: "A non-blocking improvement with no demonstrated shipped failure.",
  warning: "A real defect with a plausible user, reliability, or maintainability impact.",
  critical: "A severe security, secret-exposure, data-loss, or broadly breaking defect.",
} as const;

const probability = z.number().min(0).max(1);
const JevResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.object({
    support: z.object({
      type: z.literal("choice"),
      choice: z.enum(["supported", "insufficient", "contradicted"]),
      confidence: probability,
      probabilities: z.object({
        supported: probability,
        insufficient: probability,
        contradicted: probability,
      }),
    }),
    severity: z.object({
      type: z.literal("choice"),
      choice: z.enum(["suggestion", "warning", "critical"]),
      confidence: probability,
      probabilities: z.object({
        suggestion: probability,
        warning: probability,
        critical: probability,
      }),
    }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export interface JevFindingObservation {
  fingerprint: string;
  model: string;
  support: keyof typeof SUPPORT_CRITERIA;
  supportConfidence: number;
  supportProbabilities: Record<keyof typeof SUPPORT_CRITERIA, number>;
  severity: keyof typeof SEVERITY_CRITERIA;
  severityConfidence: number;
  severityProbabilities: Record<keyof typeof SEVERITY_CRITERIA, number>;
}

export interface JevObservation {
  configuredModel: string;
  durationMs: number;
  evaluated: number;
  skipped: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  findings: JevFindingObservation[];
  error?: string;
}

export interface ObserveWithJevOptions {
  config: LoadedConfig["jev"];
  findings: readonly Finding[];
  files: readonly DiffEntry[];
  env?: NodeJS.ProcessEnv;
  /** Explicit key captured before reviewer engines start; never forwarded to them. */
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
    if (apiKey === undefined) {
      delete env.TYPESAFE_API_KEY;
    } else {
      env.TYPESAFE_API_KEY = apiKey;
    }
  }
}

/**
 * Ask Jev typed questions about final findings. The returned record is telemetry
 * only: callers must never use it to mutate a finding or review decision.
 */
export async function observeFindingsWithJev({
  config,
  findings,
  files,
  env = process.env,
  apiKey: explicitApiKey,
  client,
}: ObserveWithJevOptions): Promise<JevObservation | undefined> {
  if (!config.enabled) return undefined;

  const started = Date.now();
  const apiKey = (explicitApiKey ?? env.TYPESAFE_API_KEY)?.trim();
  if (!client && !apiKey) {
    return emptyObservation(config, started, "TYPESAFE_API_KEY is not set");
  }

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
    return emptyObservation(config, started, "Jev client could not be initialized");
  }

  const selected = findings.slice(0, config.maxFindings);
  const patches = new Map(files.map((file) => [file.path, file.patch]));
  const results: JevFindingObservation[] = [];
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < selected.length) {
      const finding = selected[next++];
      if (!finding) continue;
      try {
        const response = JevResponseSchema.parse(
          await resolvedClient.systemOne({
            model: config.model,
            state: buildJevState(finding, patches.get(finding.file) ?? "", config.maxPatchChars),
            questions: {
              support: choice(
                "Does the supplied changed-code patch support this exact code-review finding? Judge only the supplied evidence; do not assume missing repository context.",
                SUPPORT_CRITERIA,
              ),
              severity: choice(
                "If the finding is real, what is its appropriate review severity?",
                SEVERITY_CRITERIA,
              ),
            },
          }),
        );
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        results.push({
          fingerprint: fingerprintFinding(finding),
          model: response.model,
          support: response.answers.support.choice,
          supportConfidence: response.answers.support.confidence,
          supportProbabilities: response.answers.support.probabilities,
          severity: response.answers.severity.choice,
          severityConfidence: response.answers.severity.confidence,
          severityProbabilities: response.answers.severity.probabilities,
        });
      } catch {
        // Observation is fail-open and provider errors may contain request details.
        failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));

  return {
    configuredModel: config.model,
    durationMs: Date.now() - started,
    evaluated: results.length,
    skipped: Math.max(0, findings.length - selected.length),
    failed,
    inputTokens,
    outputTokens,
    findings: results.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
  };
}

/** Build the only state sent to TypeSafe: finding metadata plus its bounded file patch. */
export function buildJevState(finding: Finding, patch: string, maxPatchChars: number) {
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
    changedCodePatch: boundPatch(patch, finding.evidence, maxPatchChars),
  };
}

function boundText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function boundPatch(patch: string, evidence: string | undefined, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  const omitted = "\n... patch omitted by ecr ...\n";
  const budget = Math.max(1, maxChars - omitted.length);
  const evidenceAt = evidence ? patch.indexOf(evidence) : -1;
  if (evidenceAt >= 0) {
    const start = Math.max(0, evidenceAt - Math.floor(budget / 2));
    return patch.slice(start, start + budget) + omitted;
  }
  const half = Math.floor(budget / 2);
  return patch.slice(0, half) + omitted + patch.slice(-half);
}

function emptyObservation(
  config: LoadedConfig["jev"],
  started: number,
  error: string,
): JevObservation {
  return {
    configuredModel: config.model,
    durationMs: Date.now() - started,
    evaluated: 0,
    skipped: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    findings: [],
    error,
  };
}
