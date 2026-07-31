// @ref LLP 0002#run-log-and-observability-sinks [implements] — one JSON line per run for cost/latency auditability
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { CoordinatorOutput, Finding, ReviewMetadata } from "./schema.js";
import type { FilteredFile } from "./noise.js";
import type { TokenUsage } from "./opencode.js";

export interface RunLogRecord {
  timestamp: string;
  mode: "ci" | "local";
  runId: string;
  // Refs only — PR title/body are deliberately excluded to avoid persisting
  // secrets that might appear in author-controlled text. Findings below may quote
  // changed source lines, but only content the review already publishes verbatim
  // in the PR comment — never the surrounding title/body text.
  // @ref LLP 0002#run-log-and-observability-sinks [constrained-by] — PR title/body excluded to avoid persisting secrets
  metadata: Pick<ReviewMetadata, "baseRef" | "headRef">;
  reviewedFiles: string[];
  filteredFiles: FilteredFile[];
  agentCosts: Record<string, number>;
  totalCost: number;
  // Aggregate token usage across all agent + coordinator requests, for cache
  // metrics (cache.read/write reveal how much prompt-cache reuse we're getting).
  // Reuses TokenUsage so the log schema can't silently diverge from what's collected.
  tokens?: TokenUsage;
  // Per-bucket token usage (same keys as agentCosts: agent ids, "cross-cutting",
  // "coordinator", "verifier") so cache effectiveness can be judged per pass, not
  // just run-wide.
  agentTokens?: Record<string, TokenUsage>;
  /** provider/model that ACTUALLY answered each pass (not what was configured). */
  agentModels?: Record<string, string>;
  /** Provider rate-limit events observed this run (OpenCode 429s + Claude Code CLI
   * subscription rate/usage limits), summed across every engine the run drove. */
  rateLimitEvents?: number;
  /** Rate-limit events split by engine, present whenever any engine reported a
   * rate-limit event (the non-triggering engine reads 0). */
  rateLimitByEngine?: { opencode: number; claudeCode: number };
  // The reasoning trail behind the posted result: raw per-agent findings before
  // coordination, the coverage gaps reported to the coordinator, and the findings
  // the verifier rejected. Together these explain WHY the final finding set looks
  // the way it does.
  agentFindings?: Record<string, Finding[]>;
  coverageNotes?: string[];
  verifierDropped?: { finding: Finding; reason: string }[];
  durationMs: number;
  decision: CoordinatorOutput["decision"] | null;
  findingCount: number;
  summary: string | null;
  error?: string;
}

/**
 * Append one JSON line per review run. Keeps inputs, findings, decision, and
 * cost together so runs are auditable and cost/latency can be measured later.
 */
export async function writeRunLog(logPath: string, record: RunLogRecord): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}
