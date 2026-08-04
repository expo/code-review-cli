// @ref LLP 0002#coordinator-and-degraded-decisions [implements] — single no-tools call; its 10-min cap adds to the serial chain, not parallel
import type { LoadedConfig } from "../config/schema.js";
import { promptAndParse } from "./opencode.js";
import type { OpencodeHandle, TokenUsage } from "./opencode.js";
import type { StackManifest } from "../sources/source.js";
import { buildCoordinatorSystem, buildCoordinatorTask } from "./prompts.js";
import { parseCoordinatorOutput } from "./schema.js";
import type { CoordinatorOutput, Finding, ReviewMetadata } from "./schema.js";

export interface CoordinationResult {
  output: CoordinatorOutput;
  cost: number;
  tokens: TokenUsage;
  // True when the coordinator hit its time budget and returned partial findings
  // via the finalize path — so the caller can flag reduced coverage rather than
  // silently presenting a truncated consolidation as complete.
  truncated: boolean;
  /** provider/model that actually answered (see PromptResult.model). */
  model?: string;
}

/**
 * Single LLM call that dedupes, re-judges severity, and decides. Structured so it
 * could later own a spawn tool, but for now stays a plain consolidation pass.
 */
// The coordinator only re-judges text (no repo tools), so it's usually quick; the
// cap is a backstop. It runs AFTER all passes, so this adds to the worst-case
// serial chain — keep it within the CI job timeout (see review.ts / workflows).
const COORDINATOR_TIMEOUT_MS = 10 * 60 * 1000;

export async function coordinate(
  handle: OpencodeHandle,
  config: LoadedConfig,
  metadata: ReviewMetadata,
  agentFindings: Record<string, Finding[]>,
  coverageNotes: string[] = [],
  stackManifest?: StackManifest | null,
  onActivity?: (line: string) => void,
): Promise<CoordinationResult> {
  const system = buildCoordinatorSystem(config);
  const text = buildCoordinatorTask(metadata, agentFindings, coverageNotes, stackManifest);
  const { value, cost, tokens, truncated, model } = await promptAndParse(
    handle,
    {
      agent: "coordinator",
      system,
      text,
      title: "review-coordinator",
      maxWaitMs: COORDINATOR_TIMEOUT_MS,
      finalizeOnTimeout: true,
      onActivity,
    },
    parseCoordinatorOutput,
  );
  return { output: value, cost, tokens, truncated, model };
}
