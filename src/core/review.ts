// @ref LLP 0002#pipeline-stages [implements] — the mode-agnostic pipeline core owning budgets, coverage, and logging
import path from "node:path";

import type { LoadedAgent, LoadedConfig } from "../config/schema.js";
import type {
  PreparedReadRoot,
  ReviewSource,
  StackManifest,
  StackWalkOptions,
} from "../sources/source.js";
import { prepareAuth } from "./auth.js";
import { coordinate } from "./coordinator.js";
import { writeRunLog } from "./log.js";
import type { RunLogRecord } from "./log.js";
import { filterNoise, writePatchWorkspace } from "./noise.js";
import type { PatchWorkspaceFile } from "./noise.js";
import {
  addTokenUsage,
  AgentTimeoutError,
  assertModelsResolvable,
  buildOpencodeConfig,
  CLAUDE_CODE_ENGINE,
  CROSS_CUTTING_AGENT,
  promptAndParse,
  STACK_VERIFIER_AGENT,
  startOpencode,
} from "./opencode.js";
import type { OpencodeHandle, TokenUsage } from "./opencode.js";
import {
  buildEngineMap,
  claudeTemperatureNote,
  claudeTokenCredential,
  startClaudeCode,
} from "./claude-code.js";
import type { ClaudeCodeHandle } from "./claude-code.js";
import { routeAgents } from "./router.js";
import {
  buildCrossCuttingSystem,
  buildCrossCuttingTask,
  buildReviewerSystem,
  buildReviewerTask,
  NO_TOOLS_INSTRUCTION,
} from "./prompts.js";
import {
  fingerprintFinding,
  isOverallRiskHandoff,
  parseReviewerOutput,
  REVIEW_TRACE_AGENT_LIMIT,
  REVIEW_TRACE_BYTES_LIMIT,
  REVIEW_TRACE_CHECKED_LIMIT,
  REVIEW_TRACE_UNCERTAINTY_LIMIT,
} from "./schema.js";
import type {
  CoordinatorOutput,
  FeedbackRecord,
  Finding,
  FindingSource,
  ResearchDecision,
  ReviewerTraceNotes,
  ReviewTrace,
} from "./schema.js";
import { adjudicateFeedback } from "./adjudicate.js";
import type { AdjudicationItem } from "./adjudicate.js";
import { buildManifestMembership, manifestKey, normalizeManifestPath } from "./stack.js";
import { confirmStackRequalifications, patchConfirmer } from "./stack-confirm.js";
import { sortFindings } from "./render.js";
import { appendStepSummary } from "./step-summary.js";
import { errorMessage, sleep } from "./util.js";
import { reviewSetupRefNotes } from "./config-refs.js";
import { verifyFindings } from "./verify.js";
import { applyInlineIgnores } from "./suppress.js";
import {
  boundResearchDecisions,
  createResearchMcpRuntime,
  formatResearchProgress,
  formatResearchUsefulness,
  groundResearchDecisions,
  groundResearchSources,
  mergeResearchSources,
  researchProvenanceFromAudit,
  renderResearchMarkdown,
  renderResearchUsefulnessMarkdown,
  summarizeResearchUsefulness,
} from "./research.js";
import type { ResearchEvidence, ResearchMcpRuntime, ResearchProvenance } from "./research.js";

export interface ReviewRunOptions {
  config: LoadedConfig;
  mode: "ci" | "local";
  onProgress?: (message: string) => void;
  /** Run only these agent ids (by filename). Takes precedence over `route`. */
  agents?: string[];
  /** Let the router pick relevant agents from the diff (ignored if `agents` set). */
  route?: boolean;
  /** Restrict the review to these repo-relative changed-file paths (scope isolation). */
  includePaths?: string[];
  /** Wall-clock ceiling for all review passes. Default: today's PASSES_BUDGET_MS. */
  passesBudgetMs?: number;
  /**
   * Directory for the run log + patch workspace (`.runs/`). Defaults to
   * `<configDir>/.runs` — correct when config lives in the checkout, WRONG when
   * config was materialized into a temporary trusted root (removed on exit, and
   * CI uploads the log from the workspace path). `ecr ci` pins this to the
   * workspace checkout explicitly.
   */
  runsDir?: string;
  /** Already-read, byte-capped external context text (untrusted); injected into the
   * reviewer + cross-cutting prompts. Read once in the command layer. */
  contextText?: string;
  /**
   * When set, walk the OPEN PRs stacked on top of this one and inject a paths-only
   * manifest into the COORDINATOR so absence-style findings a later stacked PR
   * already addresses can be requalified. Presence turns the feature on; the bounds
   * are resolved in the command layer from the trusted-base stack config (never
   * head-controlled). Absent → the manifest fetch is skipped entirely (a no-op).
   */
  stack?: StackWalkOptions;
  /**
   * v2 patch confirmation. When set (and a stack walk ran), each requalification that
   * survives deterministic grounding is confirmed against the addressing PR's actual
   * patch before it is believed; anything not clearly addressed returns to blocking.
   * Presence gates the confirmation (from the trusted-base `stack.confirmWithPatch`);
   * `maxConfirmations` caps the fan-out — overflow candidates are stripped.
   */
  // @ref LLP 0010#patch-level-confirmation-v2 [constrained-by] — gated by confirmWithPatch so v2 ships dark until flipped
  stackConfirm?: { maxConfirmations: number };
  /**
   * Author-feedback inputs. When present and `config.feedback.mode !== "off"`, the
   * replies matched to this run's findings are judged (in "adjudicate" mode) against
   * the source and the enriched records are returned on the result. Absent ⇒ the whole
   * feature is a no-op and behavior is byte-identical, which is how it ships dark.
   *
   * `match` does the comment IO in the command layer (the reporter matches replies and
   * pairs each with its reply body); the model calls stay here. The reply body is used
   * only to build the adjudicator prompt — never stored on a record, never rendered.
   */
  // @ref LLP 0011#never-echo-reply-text [constrained-by] — reply text enters only the adjudicator prompt via this seam; the returned records carry no free text
  feedback?: {
    config: LoadedConfig["feedback"];
    match: (review: CoordinatorOutput) => Promise<AdjudicationItem[]>;
  };
}

/**
 * A completed review plus, when the feedback feature is on, the author-reply records
 * matched to its findings (adjudicated and with `applied` computed). `feedback` is
 * absent whenever no feedback input was supplied or the mode is "off".
 */
export interface ReviewRunResult extends CoordinatorOutput {
  feedback?: FeedbackRecord[];
}

/**
 * Filter changed files down to an explicit include set (exact-path membership, not
 * globs — scope assignment already happened in resolveScopes). With no include set,
 * returns the input unchanged so the non-routed path is byte-identical.
 */
export function filterByIncludePaths<T extends { path: string }>(
  files: T[],
  includePaths?: string[],
): T[] {
  if (!includePaths) {
    return files;
  }
  const included = new Set(includePaths);
  return files.filter((file) => included.has(file.path));
}

function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * The invariant, mode-agnostic review core: filter → spawn each configured agent
 * → coordinate → apply policy. Returns a CoordinatorOutput; the CLI commands are
 * thin wrappers that supply a Source and render the result.
 */
/**
 * Max concurrent reviewer calls: an explicit config value wins; otherwise 3 when the
 * run leans on a subscription credential, else 6. One subscription account handles
 * six parallel streams poorly — requests get parked server-side (the stall signature
 * seen on eas-cli#4084), and several PRs may be reviewing on the same credential at
 * once — so subscription runs trade a little wall-clock for a lot of reliability.
 *
 * A subscription run is any of: an oauth (ChatGPT/Codex) entry; OR the Claude Code
 * engine being in use (an `anthropic/…` model) on an OAUTH credential — a subscription
 * token OR the local `claude` login fallback (no forwardable token). An anthropic
 * credential that classifies as an API KEY is metered per-request and does NOT force
 * the cap. Exported for tests.
 */
// @ref LLP 0002#concurrency-and-budgets [implements] — compound oauth/API-key detection is load-bearing, not simplifiable
export function effectiveConcurrency(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (config.chunk.concurrency) {
    return config.chunk.concurrency;
  }
  if (config.auth.some((entry) => entry.mode === "oauth")) {
    return 3;
  }
  if (buildEngineMap(config).usesClaude) {
    const entry = config.auth.find((auth) => auth.provider === "anthropic");
    const credential = claudeTokenCredential(entry, env);
    // No forwardable token ⇒ the `claude` login (a subscription) covers the run; an
    // "sk-ant-oat…" token is a subscription too. Either caps; an API key does not.
    if (!credential || credential.kind === "oauth") {
      return 3;
    }
  }
  return 6;
}

/** Prefix live model activity with its stable agent bucket and optional pass label. */
export function formatAgentActivity(agent: string, label: string, line: string): string {
  const pass =
    label === agent ? "" : label.startsWith(`${agent} `) ? label.slice(agent.length).trim() : label;
  const activity = line.replace(/[\r\n]+/g, " ").trim();
  return `  [${agent}] ${pass ? `${pass}: ` : ""}${activity}`;
}

export async function runReview(
  source: ReviewSource,
  options: ReviewRunOptions,
): Promise<ReviewRunResult> {
  const { config } = options;
  const started = Date.now();
  const runId = makeRunId();
  const progress = options.onProgress ?? (() => {});
  const runsRoot = options.runsDir ?? path.join(config.configDir, ".runs");
  const runDir = path.join(runsRoot, runId);
  const logPath = path.join(runsRoot, "reviews.jsonl");

  // Fail fast on an invalid explicit selection before doing any work. Routing
  // (if requested) is resolved later, once the server is up.
  const explicitAgents = options.agents?.length
    ? selectAgents(config.agents, options.agents)
    : null;

  const [metadata, changedFiles, stackManifest] = await Promise.all([
    source.getMetadata(),
    source.getChangedFiles(),
    // Only walk when enabled AND the source can (LocalGitSource omits the method).
    // The source itself fails open to null, so this never rejects the Promise.all.
    options.stack && source.getStackContextAsync
      ? source.getStackContextAsync(options.stack)
      : Promise.resolve<StackManifest | null>(null),
  ]);

  // Scope isolation: when includePaths is set, this run only ever sees its own
  // scope's files — no scope reviews another team's diff.
  const scopedFiles = filterByIncludePaths(changedFiles, options.includePaths);

  const { kept, filtered } = await filterNoise(scopedFiles, {
    additionalIgnores: config.noise.additionalIgnores,
    additionalMarkers: config.noise.additionalMarkers,
  });
  progress(
    `${scopedFiles.length} changed file(s); ${kept.length} to review, ${filtered.length} filtered.`,
  );

  const baseRecord = {
    timestamp: new Date().toISOString(),
    mode: options.mode,
    runId,
    metadata: { baseRef: metadata.baseRef, headRef: metadata.headRef },
    reviewedFiles: kept.map((entry) => entry.path),
    filteredFiles: filtered,
  };

  if (kept.length === 0) {
    const output: CoordinatorOutput = {
      decision: "approve",
      findings: [],
      summary: "No reviewable changes after noise filtering.",
      incomplete: [],
    };
    await safeLog(logPath, {
      ...baseRecord,
      agentCosts: {},
      totalCost: 0,
      durationMs: Date.now() - started,
      decision: output.decision,
      findingCount: 0,
      summary: output.summary,
    });
    return output;
  }

  let researchEvidence: ResearchEvidence[] = [];
  let researchRecord: ResearchProvenance | undefined;

  // Materialize the PR-head tree (not the current checkout) when the source can, so
  // the agents' surrounding-source reads and the verifier's re-reads see the versions
  // that match the diff. Config is already fully loaded in memory, so the chdir below
  // doesn't affect it; run-log/patch paths are absolute; gh/git calls already ran
  // above. Failure policy is MODE-DEPENDENT (see resolveReadRoot): CI fails closed —
  // with a base-SHA checkout the fallback tree is pre-PR content, and silently
  // reviewing/verifying that drops real findings — while a local run falls back to
  // the user's own checkout with a warning.
  // Resolve each agent's engine BEFORE prepareAuth/readRoot, so the per-engine
  // startup below can't leak the readRoot worktree or a temp auth dir holding a
  // live credential (buildEngineMap only inspects config, so nothing needs cleanup
  // yet at this point). Nothing throws here anymore — one run may drive BOTH the
  // Claude Code CLI engine and OpenCode at once, inferred per agent from its model.
  //
  // Scope the engine set to the SELECTED agents so a run whose passes never touch
  // Claude doesn't start (and fail on a missing CLI/token for) the Claude Code
  // engine. An explicit `--agents` subset is known here; routing picks from the full
  // roster later (its router needs an engine up first), so a routed/all run keeps
  // the full roster and can drive either engine.
  const { engineOf, modelOf, usesOpencode, usesClaude } = buildEngineMap(
    config,
    explicitAgents ?? config.agents,
  );

  const originalCwd = process.cwd();
  const readRoot = await resolveReadRoot(source, options.mode, progress);

  // Prepare auth BEFORE the chdir below: it doesn't depend on the working directory,
  // and doing it after readRoot but before chdir means a prepareAuth failure can't
  // leave cwd pointing at the worktree — it only has the worktree itself to release.
  let auth: Awaited<ReturnType<typeof prepareAuth>>;
  try {
    auth = await prepareAuth(config);
  } catch (error) {
    await readRoot?.cleanup();
    throw error;
  }

  const restoreCwd = async (): Promise<void> => {
    if (readRoot) {
      process.chdir(originalCwd);
      await readRoot.cleanup();
    }
  };
  if (readRoot) {
    progress("Reviewing the PR-head tree (so reads match the PR, not the checkout).");
    process.chdir(readRoot.dir);
  }

  // Ref integrity of the setup that is about to review this PR. Resolved against the
  // tree the reviewers read (PR head when materialized), while the setup itself may
  // come from the trusted base ref — so a PR that moves cited code is reported against
  // the prompts that will actually judge it.
  // @ref LLP 0012#run-points-command-and-review [implements] — every review checks its own refs; advice only, never a gate
  const setupNotes = await reviewSetupRefNotes({
    root: readRoot?.dir ?? originalCwd,
    setupDirs: [config.configDir],
    changedFiles: kept.map((entry) => entry.path),
  });
  for (const note of setupNotes) {
    progress(`  setup: ${note}`);
  }

  let researchRuntime: ResearchMcpRuntime | undefined;
  try {
    researchRuntime = await createResearchMcpRuntime(config.research);
    if (researchRuntime) {
      progress(
        `Documentation MCP enabled for reviewer passes (${config.research.maxQueries} calls max; queries and results will be reported).`,
      );
    }
  } catch (error) {
    await auth.cleanup();
    await restoreCwd();
    throw new Error(`Failed to prepare the documentation MCP: ${errorMessage(error)}`);
  }

  const starting = [
    usesClaude ? "Claude Code engine" : null,
    usesOpencode ? "OpenCode server" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  progress(`Starting ${starting}…`);

  // Start each engine the run actually uses. OpenCode first so a claude failure can
  // close it. Two separate try blocks keep the precise per-engine error messages.
  let opencodeHandle: OpencodeHandle | null = null;
  let claudeHandle: ClaudeCodeHandle | null = null;
  try {
    if (usesOpencode) {
      opencodeHandle = await startOpencode(buildOpencodeConfig(config, researchRuntime));
    }
  } catch (error) {
    await auth.cleanup();
    await researchRuntime?.cleanup();
    await restoreCwd();
    throw new Error(
      `Failed to start the OpenCode server. Ensure the \`opencode\` CLI is installed and ` +
        `model credentials are configured (\`ecr doctor\` checks both).\n${errorMessage(error)}`,
    );
  }
  try {
    if (usesClaude) {
      claudeHandle = await startClaudeCode(config, researchRuntime);
    }
  } catch (error) {
    opencodeHandle?.close();
    await auth.cleanup();
    await researchRuntime?.cleanup();
    await restoreCwd();
    throw new Error(
      `Failed to start the Claude Code engine. Ensure the \`claude\` CLI is installed and ` +
        `logged into a Max/Team subscription (\`ecr doctor\` checks both).\n${errorMessage(error)}`,
    );
  }

  // Build the single carrier handle so every downstream `handle` call is unchanged;
  // per-agent dispatch happens inside via engineOf. When OpenCode is in use the
  // carrier is the opencode handle (claude reached via `.claude`); a claude-only run
  // uses the claude handle itself as the carrier (engineOf maps every id → claude).
  const engineFn = (agent: string): "opencode" | "claude-code" => engineOf[agent] ?? "opencode";
  let handle: OpencodeHandle;
  if (opencodeHandle) {
    handle = opencodeHandle;
    handle.claude = claudeHandle ?? undefined;
    handle.engineOf = engineFn;
    const closeOpencode = opencodeHandle.close;
    handle.close = (): void => {
      closeOpencode();
      claudeHandle?.close(); // claude close is a noop, but keep the composition explicit
    };
  } else {
    handle = claudeHandle!; // claude-only: the carrier is the claude handle itself
    handle.engineOf = engineFn;
  }

  // The claude-code engine has no temperature control (the CLI exposes no flag), so
  // surface a tuned-but-ignored temperature once, here, instead of letting the config
  // divergence pass silently. Applies whenever any pass is claude-routed.
  if (usesClaude) {
    const note = claudeTemperatureNote(config, engineOf);
    if (note) {
      progress(`Note: ${note}`);
    }
  }

  // Preflight: a model id an engine can't resolve would otherwise fail EVERY pass
  // routed to it identically — N indistinguishable coverage gaps, after spending the
  // run's budget rediscovering the same fixable thing. Throw once, up front, naming
  // the fix. Split per engine so each engine only ever sees its own model subset: the
  // OpenCode server never receives an anthropic-claude id (unknown-provider error) and
  // assertClaudeModels never receives a non-anthropic id (its foreign-id throw).
  const modelsFor = (eng: "opencode" | "claude-code"): string[] => [
    ...new Set(
      Object.keys(engineOf)
        .filter((id) => engineOf[id] === eng)
        .map((id) => modelOf[id]!),
    ),
  ];
  try {
    if (opencodeHandle) {
      const models = modelsFor("opencode");
      if (models.length > 0) {
        await assertModelsResolvable(opencodeHandle, models, config.auth);
      }
    }
    if (claudeHandle) {
      const models = modelsFor("claude-code");
      if (models.length > 0) {
        await assertModelsResolvable(claudeHandle, models, config.auth);
      }
    }
  } catch (error) {
    handle.close();
    await auth.cleanup();
    await researchRuntime?.cleanup();
    await restoreCwd();
    throw error;
  }

  const agentCosts: Record<string, number> = {};
  const tokenTotals: TokenUsage = {};
  const agentTokens: Record<string, TokenUsage> = {};
  // Declared outside the try so the error-path log still carries whatever the
  // reviewers produced before the failure — partial findings are exactly what's
  // needed to debug a run that died mid-way.
  const agentFindings: Record<string, Finding[]> = {};
  // Reviewer-declared, conclusion-only records of cases where documentation changed
  // a concrete candidate decision. They remain inert until exact-source grounding.
  const agentResearchDecisions: Record<string, ResearchDecision[]> = {};
  // Bounded, conclusion-only diagnostics for machine consumers of the hidden
  // comment state. These are deliberately separate from findings: they never reach
  // the coordinator, verification, policy, or decision paths.
  const agentTrace: Record<string, ReviewerTraceNotes> = {};
  // First reviewer (by scheduling order) that produced each fingerprint, so a finding's
  // originating agent can be carried through the coordinator's merge/rewrite by matching
  // on fingerprint. Kept separate from agentFindings so the coordinator prompt and the
  // run log stay byte-identical (attribution is engine metadata, never sent to a model).
  // @ref LLP 0011#attribution-and-identity [constrained-by] — engine-set, excluded from fingerprintFinding, so attribution never re-keys a dismissal
  const agentByFp = new Map<string, string>();
  // Grounded source citations ride through coordinator rewrites by the same stable
  // fingerprint. The model may select an injected source, but cannot invent its URL.
  const sourcesByFp = new Map<string, FindingSource[]>();
  // Every model request's usage lands in the run total AND its bucket, so the run
  // log can show cache effectiveness per pass and not just run-wide.
  const trackTokens = (bucket: string, tokens?: TokenUsage): void => {
    addTokenUsage(tokenTotals, tokens);
    addTokenUsage((agentTokens[bucket] ??= {}), tokens);
  };
  // The provider/model that ACTUALLY answered each pass, and any pass whose model was
  // silently substituted for the configured one. OpenCode does that substitution
  // quietly whenever an agent's model id is empty or unusable, so a run can review with
  // a different model than config.jsonc names and look completely normal — which is
  // exactly what happened for weeks behind an empty REVIEWER_MODEL. Recorded in the run
  // log, reported in the log line, and surfaced as a coverage note when it happens.
  const agentModels: Record<string, string> = {};
  const substituted = new Set<string>();
  // The buckets whose model was substituted, so the coverage note can name each
  // one's OWN engine (a mixed run may substitute on either side, for different
  // reasons — a CLI usage-limit downgrade vs. OpenCode's silent default fallback).
  const substitutedBuckets = new Set<string>();
  const trackModel = (bucket: string, configured: string, actual?: string): void => {
    if (!actual) {
      return;
    }
    agentModels[bucket] = actual;
    if (configured && actual !== configured) {
      substituted.add(`${bucket}: configured ${configured}, ran ${actual}`);
      substitutedBuckets.add(bucket);
    }
  };

  try {
    const workspace = await writePatchWorkspace(kept, metadata, runDir);

    // Resolve which agents run: an explicit list wins; otherwise route (LLM picks
    // relevant agents + always-run) when asked, else all.
    let selectedAgents = explicitAgents ?? config.agents;
    if (!explicitAgents && options.route) {
      progress("Routing: selecting relevant agents…");
      const routed = await routeAgents(handle, config, workspace.files, (line) =>
        progress(formatAgentActivity("router", "router", line)),
      );
      selectedAgents = routed.agents;
      progress(
        routed.routed
          ? `Router selected: ${selectedAgents.map((a) => a.id).join(", ")}`
          : "Router unavailable; running all agents.",
      );
    }

    // Split the diff into focused chunks so each reviewer call sees a small file
    // set (better recall than one giant blob), and run all agent×chunk calls
    // concurrently up to a cap.
    const chunks = chunkByLines(
      workspace.files,
      config.chunk.maxChangedLines,
      config.chunk.maxFiles,
    );
    // Only chunk (and add a cross-cutting pass) when the diff exceeds one chunk.
    const chunked = chunks.length > 1;
    const concurrency = effectiveConcurrency(config);
    progress(
      `Running ${selectedAgents.length} reviewer(s) [${selectedAgents.map((a) => a.id).join(", ")}] over ${chunks.length} chunk(s)` +
        `${chunked ? " + cross-cutting pass" : ""} ` +
        `(${kept.length} files, concurrency ${concurrency})…`,
    );

    for (const agent of selectedAgents) {
      agentFindings[agent.id] = [];
      agentCosts[agent.id] = 0;
    }

    interface ReviewTask {
      // Bucket the findings land in (agent id, or "cross-cutting" for the one
      // combined multi-file pass).
      bucket: string;
      kind: "reviewer" | "cross-cutting";
      system: string;
      label: string;
      title: string;
      // The files this task reviews. Kept (not a prebuilt prompt) so a timed-out
      // task can be SUBDIVIDED into smaller file sets that converge.
      files: PatchWorkspaceFile[];
      // Human label for coverage notes (no internal [i/n]/[cross-file] jargon).
      coverageLabel: string;
      // Per-task time ceiling. The cross-cutting pass legitimately does more work
      // (tracing across every changed file), so it gets more than a focused chunk.
      maxWaitMs: number;
      // Soft tool-call ceiling; hitting it triggers the same soft-landing as the
      // time cap. Bounds an agent that wanders instead of converging.
      maxToolCalls: number;
      // Subdivision depth (0 = an original chunk); a backstop on recursion.
      depth: number;
      // A last-resort no-tools pass over a chunk that wouldn't converge even after
      // being subdivided — reviews the inlined diff only, so it always returns.
      fallback: boolean;
    }
    // These caps must fit inside PASSES_BUDGET_MS (below), which in turn fits inside
    // the CI job's timeout-minutes.
    const CHUNK_TIMEOUT_MS = 15 * 60 * 1000;
    // A subdivided sub-chunk is smaller, so it gets a shorter cap (halved per level,
    // floored) — enough to converge without letting the recursion balloon.
    const SUBDIVIDE_MIN_TIMEOUT_MS = 6 * 60 * 1000;
    const MAX_SUBDIVIDE_DEPTH = 6;
    // The no-tools fallback reviews an inlined diff with no exploration, so it's fast.
    const FALLBACK_TIMEOUT_MS = 4 * 60 * 1000;
    // Tool-call ceilings — generous for a legitimate pass, low enough to catch
    // runaway roaming (the root cause of the non-convergent timeouts).
    const CHUNK_MAX_TOOL_CALLS = 50;
    // Global ceiling for ALL passes incl. subdivision/fallback waves, sized to
    // leave room for the coordinator (10m) + verification + overhead inside the CI
    // job timeout. Past this, a timed-out pass is reported as a gap rather than
    // broken down further, so total wall-clock stays bounded.
    const PASSES_BUDGET_MS = 55 * 60 * 1000;
    const passesBudgetMs = options.passesBudgetMs ?? PASSES_BUDGET_MS;
    const passesDeadline = started + passesBudgetMs;

    // The cross-file pass is the one pass whose scope cannot be traded for
    // convergence: halving its file set deletes exactly the coverage it exists to
    // provide (see the timeout branch below). So instead of a fixed cap it gets the
    // WHOLE remaining passes window. Chunk passes run concurrently alongside it under
    // their own caps, so a long cross-file pass doesn't starve them — it only extends
    // the run toward the passes deadline, which the job timeout is sized for.
    //
    // Computed here, not as a constant, because the window is what's actually left:
    // filtering, routing and server startup already spent some of it, and `ecr ci`
    // divides the budget across active scopes.
    //
    // The reserve is what keeps its own salvage paths affordable: if it expanded into
    // the entire window, then on a timeout there would be nothing left to run the
    // whole-diff no-tools fallback with, and "elastic budget" would have quietly
    // reintroduced the coverage gap it exists to prevent. Sized for the finalize
    // soft-landing plus one FALLBACK_TIMEOUT_MS pass.
    // @ref LLP 0002#the-cross-cutting-pass [constrained-by] — not a trimmable margin; funds the whole-diff fallback on timeout
    const CROSS_CUTTING_RESERVE_MS = FALLBACK_TIMEOUT_MS + 4 * 60 * 1000;
    // Floor: never LESS generous than one chunk pass. On a run whose window is already
    // small (many active scopes dividing the budget) this can exceed what's left, but
    // that exposure is exactly what chunk passes already carry — their 15m cap can also
    // outlast a small per-scope slice — and the job timeout keeps a wide margin over
    // the budget for it. Dropping the pass instead would silently cost the coverage no
    // other pass provides.
    const crossCuttingWaitMs = Math.max(
      CHUNK_TIMEOUT_MS,
      passesDeadline - Date.now() - CROSS_CUTTING_RESERVE_MS,
    );
    // Tool calls are for TRACING (opening the caller a changed signature affects) —
    // the changed files' diffs are inlined, so they are not spent fetching the diff.
    // Scale with the diff's file count instead of fixing the ceiling: under a large
    // elastic time budget a fixed cap becomes the binding constraint, and the extra
    // time can't be used.
    const CROSS_CUTTING_TOOL_CALLS_PER_FILE = 10;
    const CROSS_CUTTING_MIN_TOOL_CALLS = 120;
    const CROSS_CUTTING_MAX_TOOL_CALLS = 400;
    const crossCuttingMaxToolCalls = Math.min(
      CROSS_CUTTING_MAX_TOOL_CALLS,
      Math.max(
        CROSS_CUTTING_MIN_TOOL_CALLS,
        CROSS_CUTTING_TOOL_CALLS_PER_FILE * workspace.files.length,
      ),
    );

    // Coverage notes for passes that hit their time limit, stalled, failed, or were
    // never started, surfaced in the final review so a cut-short run is never
    // presented as complete.
    const incomplete: string[] = [];

    const tasks: ReviewTask[] = [];
    for (const agent of selectedAgents) {
      const system = buildReviewerSystem(config, agent);
      chunks.forEach((chunk, index) => {
        tasks.push({
          bucket: agent.id,
          kind: "reviewer",
          system,
          label: chunked ? `${agent.id} [${index + 1}/${chunks.length}]` : agent.id,
          title: `review-${agent.id}-c${index}`,
          files: chunk,
          coverageLabel: `the ${agent.id} review${chunked ? ` (part ${index + 1} of ${chunks.length})` : ""}`,
          maxWaitMs: CHUNK_TIMEOUT_MS,
          maxToolCalls: CHUNK_MAX_TOOL_CALLS,
          depth: 0,
          fallback: false,
        });
      });
    }
    // On a large diff, ONE combined pass (not one per agent) looks for issues that
    // span multiple changed files, covering every agent's concern at once.
    if (chunked) {
      tasks.push({
        bucket: CROSS_CUTTING_AGENT,
        kind: "cross-cutting",
        system: buildCrossCuttingSystem(config),
        label: "cross-file",
        title: "review-xcut",
        files: workspace.files,
        coverageLabel: "the cross-file review (issues spanning multiple changed files)",
        maxWaitMs: crossCuttingWaitMs,
        maxToolCalls: crossCuttingMaxToolCalls,
        depth: 0,
        fallback: false,
      });
    }

    // Longest-processing-time-first: schedule the long cross-cutting/large chunks
    // ahead of short ones so they don't dominate the tail of the makespan.
    tasks.sort((a, b) => b.maxWaitMs - a.maxWaitMs);

    // What each task was CONFIGURED to run on — mirrors buildOpencodeConfig, which
    // gives the cross-file pass the first agent's model. Compared against what actually
    // answered so a silent substitution can't pass unnoticed.
    const taskModel = (task: ReviewTask): string =>
      task.kind === "cross-cutting"
        ? (selectedAgents[0]?.model ?? config.coordinator.model)
        : (selectedAgents.find((agent) => agent.id === task.bucket)?.model ?? "");

    // Build the task prompt on demand (so a subdivided task rebuilds over its
    // smaller file set); a fallback task forbids tools and reviews the inlined diff.
    const buildTaskText = (task: ReviewTask): string => {
      const base =
        task.kind === "cross-cutting"
          ? buildCrossCuttingTask(
              task.files,
              selectedAgents,
              filtered,
              { noTools: task.fallback },
              options.contextText,
              Boolean(researchRuntime) && !task.fallback,
            )
          : buildReviewerTask(
              task.files,
              workspace.files,
              filtered,
              options.contextText,
              Boolean(researchRuntime) && !task.fallback,
            );
      return task.fallback ? `${base}\n\n${NO_TOOLS_INSTRUCTION}` : base;
    };
    const filesLabel = (files: PatchWorkspaceFile[]): string =>
      files.length === 1
        ? `\`${files[0]!.path}\``
        : `${files.length} files (e.g. \`${files[0]!.path}\`)`;
    const humanBucket = (bucket: string): string =>
      bucket === CROSS_CUTTING_AGENT ? "cross-file" : bucket;
    const childTask = (
      parent: ReviewTask,
      files: PatchWorkspaceFile[],
      labelSuffix: string,
      overrides: Partial<ReviewTask>,
    ): ReviewTask => ({
      ...parent,
      files,
      label: `${parent.label} ${labelSuffix}`,
      coverageLabel: `the ${humanBucket(parent.bucket)} review of ${filesLabel(files)}`,
      ...overrides,
    });

    let completedPasses = 0;
    let failedPasses = 0;
    const taskProgress = (task: ReviewTask, line: string): void =>
      progress(formatAgentActivity(task.bucket, task.label, line));
    // promptAndParse already retries internally (same-session corrective, then a
    // bounded fresh session). We do NOT wrap it in another retry loop. On a genuine
    // TIMEOUT, instead of dropping the work we break it into units that converge:
    // subdivide the chunk, then a fast no-tools pass, and only report a coverage gap
    // when even that can't finish inside the budget — so dropped work is never silent.
    await runGrowableQueue(tasks, concurrency, async (task, enqueue) => {
      const minutes = Math.round(task.maxWaitMs / 60000);
      try {
        const { value, cost, truncated, tokens, model } = await promptAndParse(
          handle,
          {
            agent: task.bucket,
            system: task.system,
            text: buildTaskText(task),
            title: task.title,
            onActivity: (line) => taskProgress(task, line),
            maxWaitMs: task.maxWaitMs,
            maxToolCalls: task.maxToolCalls,
            finalizeOnTimeout: true,
          },
          parseReviewerOutput,
        );
        agentCosts[task.bucket] = (agentCosts[task.bucket] ?? 0) + cost;
        trackTokens(task.bucket, tokens);
        trackModel(task.bucket, taskModel(task), model);
        (agentFindings[task.bucket] ??= []).push(...value.findings);
        if (value.researchDecisions) {
          (agentResearchDecisions[task.bucket] ??= []).push(...value.researchDecisions);
        }
        if (value.trace) {
          mergeTraceNotes(agentTrace, task.bucket, value.trace);
        }
        for (const finding of value.findings) {
          const fp = fingerprintFinding(finding);
          if (!agentByFp.has(fp)) {
            agentByFp.set(fp, task.bucket);
          }
        }
        completedPasses++;
        if (truncated) {
          taskProgress(task, "hit its budget — returned partial findings");
          incomplete.push(
            `${capitalize(task.coverageLabel)} ran out of time; its findings may be incomplete.`,
          );
        }
        return;
      } catch (error) {
        // Non-timeout errors are genuine failures — record and move on.
        if (!(error instanceof AgentTimeoutError)) {
          failedPasses++;
          taskProgress(task, `FAILED (${errorMessage(error)})`);
          // An auth/permission failure hits every pass identically; push one shared,
          // actionable note (deduped into a single coverage line) instead of N generic
          // per-pass failures that bury the real, fixable cause.
          incomplete.push(
            isAuthError(error)
              ? AUTH_FAILURE_NOTE
              : `${capitalize(task.coverageLabel)} failed to run; those changes were not reviewed.`,
          );
          return;
        }
        // Account for the abandoned investigation's spend regardless of what's next.
        agentCosts[task.bucket] = (agentCosts[task.bucket] ?? 0) + error.cost;
        trackTokens(task.bucket, error.tokens);

        const remaining = passesDeadline - Date.now();
        // Subdividing trades scope for convergence, which is the right trade for a
        // reviewer chunk (each file still gets reviewed) and the WRONG one for the
        // cross-file pass: an interaction between a file in the left half and one in
        // the right half is invisible to both halves, so "splitting" it silently
        // deletes the coverage the pass exists to provide while reporting success.
        // It goes straight to the whole-diff no-tools fallback below instead.
        const canSubdivide = task.kind === "reviewer" && task.files.length > 1;
        const childCap = Math.max(SUBDIVIDE_MIN_TIMEOUT_MS, Math.floor(task.maxWaitMs / 2));
        if (canSubdivide && task.depth < MAX_SUBDIVIDE_DEPTH && remaining > childCap) {
          const mid = Math.ceil(task.files.length / 2);
          const left = task.files.slice(0, mid);
          const right = task.files.slice(mid);
          taskProgress(
            task,
            `exceeded ${minutes}m — splitting into 2 smaller passes (${left.length} + ${right.length} files)`,
          );
          const over: Partial<ReviewTask> = { depth: task.depth + 1, maxWaitMs: childCap };
          enqueue(childTask(task, left, `↳${left.length}f`, over));
          enqueue(childTask(task, right, `↳${right.length}f`, over));
          return;
        }
        // Can't (or shouldn't) subdivide: fall back to a fast no-tools pass over the
        // inlined diffs. This works for the cross-file pass too — every changed file's
        // diff is inlined in its task, so it can still reason across the whole diff
        // without tools; it just can't open a caller outside the diff. A lighter
        // cross-file review beats the coverage gap it used to report.
        if (!task.fallback && remaining > FALLBACK_TIMEOUT_MS) {
          taskProgress(
            task,
            `exceeded ${minutes}m — retrying ${filesLabel(task.files)} with a fast no-tools pass`,
          );
          enqueue(
            childTask(task, task.files, "(no-tools fallback)", {
              fallback: true,
              maxWaitMs: FALLBACK_TIMEOUT_MS,
              maxToolCalls: 0,
            }),
          );
          return;
        }
        // Genuine, reported gap — the only way work is ever left unreviewed, and
        // never silent. Distinguish WHY so the note doesn't overstate what happened:
        // we could still have split/fallen back, but the global budget ran out first,
        // vs. the task was already at its smallest reviewable unit and still failed.
        // A stalled pass is called out separately: it did not run out of time doing
        // work, its model requests went silent, which is an infrastructure symptom
        // and not something a bigger budget or a smaller scope would have fixed.
        failedPasses++;
        const couldStillReduce =
          (canSubdivide && task.depth < MAX_SUBDIVIDE_DEPTH) || !task.fallback;
        if (error.reason === "stall") {
          taskProgress(
            task,
            `its model requests went silent (stalled) and did not recover — ` +
              `most likely provider rate limiting; reporting a coverage gap`,
          );
          // Name the likely cause. OpenCode retries a 429 internally without surfacing
          // it, so provider throttling reaches us as pure silence — indistinguishable
          // from a wedged connection, and the single most common reason a pass produces
          // nothing at all. Saying "went silent" alone sends people hunting for a bug
          // in the reviewer instead of checking their usage window.
          incomplete.push(
            `${capitalize(task.coverageLabel)} could not run: its model requests went silent and produced no output, even after being retried. ` +
              `The usual cause is the model provider rate-limiting the account (a subscription credential over its usage window), which reaches this tool as silence rather than an error; ` +
              `those changes were not fully reviewed.`,
          );
        } else if (couldStillReduce) {
          taskProgress(
            task,
            `exceeded ${minutes}m and the run's time budget is spent — reporting a coverage gap`,
          );
          incomplete.push(
            `${capitalize(task.coverageLabel)} timed out and the overall review budget was exhausted before it could be broken down further; those changes were not fully reviewed.`,
          );
        } else {
          taskProgress(
            task,
            `exceeded ${minutes}m even at its smallest reviewable unit — reporting a coverage gap`,
          );
          incomplete.push(
            `${capitalize(task.coverageLabel)} exceeded its time budget even after being reduced to its smallest reviewable unit; those changes were not fully reviewed.`,
          );
        }
      }
    });

    if (researchRuntime) {
      try {
        const audited = await researchProvenanceFromAudit(researchRuntime.auditPath);
        researchRecord = audited.provenance;
        researchEvidence = audited.evidence;
        for (const line of formatResearchProgress(researchRecord)) progress(line);
        await appendStepSummary(renderResearchMarkdown(researchRecord));
      } catch (error) {
        researchRecord = { queries: [], results: [], warnings: [], error: errorMessage(error) };
        progress(`  research audit unavailable: ${researchRecord.error}`);
      }
    }
    // Citations are accepted only when their exact canonical URL appeared in this
    // run's MCP audit. This strips invented URLs even if a model copied a plausible
    // official-looking address into its structured output.
    for (const [bucket, findings] of Object.entries(agentFindings)) {
      const grounded = groundResearchSources(findings, researchEvidence);
      agentFindings[bucket] = grounded;
      for (const finding of grounded) {
        if (!finding.sources?.length) continue;
        const fp = fingerprintFinding(finding);
        sourcesByFp.set(fp, mergeResearchSources(sourcesByFp.get(fp), finding.sources));
      }
    }
    if (researchRecord) {
      const groundedDecisions = Object.entries(agentResearchDecisions).flatMap(([agent, records]) =>
        groundResearchDecisions(records, researchEvidence, agent),
      );
      const { decisions, omitted } = boundResearchDecisions(groundedDecisions);
      if (decisions.length > 0) researchRecord = { ...researchRecord, decisions };
      if (omitted > 0) {
        const warning = `${omitted} grounded research decision(s) omitted by output bounds`;
        researchRecord = {
          ...researchRecord,
          warnings: [...researchRecord.warnings, warning],
        };
        progress(`  research: ${warning}`);
      }
    }

    // A substituted model means the review did not run on the model this repo
    // configured — the findings may be from a weaker (or free-tier) model entirely.
    // Never silent: it goes to the log, the coverage notes, and the run log.
    if (substituted.size > 0) {
      for (const line of substituted) {
        progress(`  ⚠ model substituted — ${line}`);
      }
      const subEngines = new Set(
        [...substitutedBuckets].map((bucket) => engineOf[bucket] ?? "opencode"),
      );
      const why: string[] = [];
      if (subEngines.has(CLAUDE_CODE_ENGINE)) {
        why.push(
          "The Claude Code CLI answered with a different model than configured (usage-limit " +
            "downgrades do this on a subscription), so these findings may come from a weaker " +
            "model than intended — check the configured model ids and the subscription's limits.",
        );
      }
      if (subEngines.has("opencode")) {
        why.push(
          "OpenCode silently falls back to a default model when the configured id is empty or " +
            "unusable, so these findings may come from a different (possibly much weaker) model " +
            "than intended — check the agents' `model`, `coordinator.model`, REVIEWER_MODEL, and the provider credential.",
        );
      }
      incomplete.push(
        `Some passes did not run on the configured model (${[...substituted].join("; ")}). ` +
          why.join(" "),
      );
    }

    // Note: routine noise filtering (lockfiles, generated, binary) is expected and
    // NOT a coverage gap — it stays in the run log (filteredFiles), not the
    // user-facing coverage note, which is reserved for passes that didn't finish.
    const coverageNotes = [...new Set(incomplete)];

    // Severity LOCK: capture which FILES carried a critical/secrets/security reviewer
    // finding BEFORE the coordinator can lower or rewrite it. groundStackRequalification
    // uses this so a coordinator steered into "downgrade critical→warning, then
    // requalify" can't slip a real critical past the carve-out. Built here (after the
    // fan-out populated agentFindings) whether or not the stack feature is on — cheap,
    // and keeps the grounding call unconditional.
    const preCoordinationFileLocks = buildPreCoordinationFileLocks(agentFindings);

    let output: CoordinatorOutput;
    if (completedPasses === 0) {
      // Nothing succeeded — do NOT let this render as a clean "approve".
      progress("All review passes failed — reporting an incomplete review.");
      output = {
        decision: "approve_with_comments",
        findings: [],
        summary:
          "⚠️ The AI review could not complete: every review pass failed or timed out, " +
          'so these changes were effectively NOT reviewed. Treat this as "no review", not "looks good".',
        incomplete: coverageNotes,
        // Presentation override: without it the comment header reads "Decision:
        // Approve with comments" over a review that reviewed nothing (euxy#8).
        couldNotComplete: true,
      };
    } else {
      progress("Coordinating findings…");
      let consolidated: CoordinatorOutput;
      try {
        const {
          output: rawOutput,
          cost,
          tokens: coordinatorTokens,
          truncated: coordinatorTruncated,
          model: coordinatorModel,
        } = await coordinate(
          handle,
          config,
          metadata,
          agentFindings,
          coverageNotes,
          stackManifest,
          (line) => progress(formatAgentActivity("coordinator", "coordinator", line)),
        );
        agentCosts["coordinator"] = cost;
        trackTokens("coordinator", coordinatorTokens);
        trackModel("coordinator", config.coordinator.model, coordinatorModel);
        consolidated = applyReviewPolicy(rawOutput, config.policy);
        if (coordinatorTruncated) {
          // The coordinator ran out of time and returned partial findings — flag it
          // like any other truncated pass so reduced coverage is never silent.
          coverageNotes.push(
            "The consolidation step ran out of time and returned partial findings; some findings may have been dropped or not fully de-duplicated.",
          );
        }
      } catch (error) {
        // The coordinator is the last step; if it fails we must not throw away all
        // the findings the agents already produced. Fall back to a deterministic
        // merge so a comment is still posted.
        progress(`Coordinator failed (${errorMessage(error)}); consolidating findings locally.`);
        consolidated = fallbackConsolidation(agentFindings, config.policy);
        coverageNotes.push(
          "The consolidation step failed, so findings are shown merged but not de-duplicated or re-judged.",
        );
      }
      // A run with any failed/timed-out pass must never present as a clean approve.
      const decision =
        failedPasses > 0 && consolidated.decision === "approve"
          ? "approve_with_comments"
          : consolidated.decision;
      output = { ...consolidated, decision, incomplete: [...new Set(coverageNotes)] };
    }

    // The coordinator remains model output. Revalidate every citation against the
    // allowlisted prepass before verification, persistence, or rendering.
    output = {
      ...output,
      findings: groundResearchSources(output.findings, researchEvidence),
    };

    // Guard against hallucinated findings before surfacing: quote-ground every
    // finding against the real file, and adversarially verify criticals. This is
    // what stops a confident but wrong critical from shipping.
    // @ref LLP 0002#post-coordination-order [constrained-by] — verify must run before suppress; order is load-bearing
    const findingCountBeforeChecks = output.findings.length;
    const decisionBeforeChecks = output.decision;
    let verifierDropped: { finding: Finding; reason: string }[] = [];
    // Stripped requalifications (finding + reason), persisted to the run log so the
    // stack-aware decision trail is auditable after the fact — mirrors verifierDropped.
    const requalificationStrips: { finding: Finding; reason: string }[] = [];
    if (output.findings.length > 0) {
      progress("Verifying findings…");
      const verification = await verifyFindings(handle, output.findings, process.cwd(), progress);
      agentCosts["verifier"] = verification.cost;
      trackTokens("verifier", verification.tokens);
      // Mirrors buildOpencodeConfig, which gives the verifier the first agent's model.
      trackModel(
        "verifier",
        config.agents[0]?.model ?? config.coordinator.model,
        verification.model,
      );
      verifierDropped = verification.dropped;
      if (verification.dropped.length > 0) {
        progress(`Verification dropped ${verification.dropped.length} unverified finding(s).`);
        output = {
          ...output,
          findings: verification.kept,
          decision: decisionAfterVerification(output.decision, verification.kept),
        };
      }
    }

    // Stack-aware requalification grounding (deterministic, zero LLM): strip any
    // `requalifiedBy` the coordinator wrote that is forged, hallucinated, or touches a
    // protected finding class, then re-derive the decision over the still-BLOCKING
    // (non-requalified) subset. Runs between verify and suppress, preserving the
    // load-bearing verify → ground → suppress → reconcile order.
    // @ref LLP 0010#grounding-and-the-decision [constrained-by] — must run after verify and before suppress; a stripped requalification means the finding stays fully blocking
    if (output.findings.length > 0) {
      // The decision entering this block (post-verify, pre-requalification softening)
      // is the ceiling both grounding and confirmation re-derive against: confirmation
      // returns findings to blocking, so re-running decisionAfterRequalification over
      // the post-confirmation set re-hardens up to this value, never past it.
      const decisionBeforeRequalification = output.decision;
      const grounding = groundStackRequalification(
        output.findings,
        stackManifest,
        preCoordinationFileLocks,
        progress,
      );
      requalificationStrips.push(...grounding.stripped);
      let grounded = grounding.findings;
      // v2 patch confirmation (gated by stack.confirmWithPatch): for the requalifications
      // that survived grounding, read the addressing PR's actual patch and strip any not
      // clearly addressed. Fail toward blocking on any fetch/verify error or timeout.
      // @ref LLP 0010#patch-level-confirmation-v2 [constrained-by] — runs right after grounding, before the decision is re-derived; never materializes the patch
      if (
        options.stackConfirm &&
        stackManifest &&
        grounded.some((finding) => finding.requalifiedBy)
      ) {
        progress("Confirming stacked-PR requalifications against their patches…");
        const confirmation = await confirmStackRequalifications(
          grounded,
          options.stackConfirm.maxConfirmations,
          patchConfirmer(handle, source, (line) =>
            progress(formatAgentActivity(STACK_VERIFIER_AGENT, STACK_VERIFIER_AGENT, line)),
          ),
          progress,
        );
        grounded = confirmation.findings;
        requalificationStrips.push(...confirmation.strippedFindings);
        agentCosts[STACK_VERIFIER_AGENT] = confirmation.cost;
        trackTokens(STACK_VERIFIER_AGENT, confirmation.tokens);
        trackModel(
          STACK_VERIFIER_AGENT,
          config.agents[0]?.model ?? config.coordinator.model,
          confirmation.model,
        );
        if (confirmation.stripped > 0) {
          progress(
            `Stack confirmation returned ${confirmation.stripped} requalified finding(s) to blocking.`,
          );
        }
      }
      output = {
        ...output,
        findings: grounded,
        // decisionAfterGrounding only re-derives when a requalification SURVIVED
        // grounding + confirmation: with none, the coordinator's decision must stand
        // untouched — an unconditional decisionAfterRequalification here would
        // soften every non-critical request_changes on every run, stack feature or
        // not. Criticals never carry requalifiedBy (grounding strips it), so the
        // later decisionAfterRequalification call in the suppression block cannot
        // re-escalate past this softened decision.
        decision: decisionAfterGrounding(decisionBeforeRequalification, grounded),
      };
    }

    // Inline `expo-code-review-ignore` directives suppress non-critical findings.
    if (output.findings.length > 0) {
      const { kept, suppressed } = await applyInlineIgnores(
        output.findings,
        process.cwd(),
        progress,
      );
      if (suppressed.length > 0) {
        progress(`Suppressed ${suppressed.length} finding(s) via inline directives.`);
        output = {
          ...output,
          findings: kept,
          // decisionAfterRequalification, NOT decisionAfterVerification: `kept` may
          // still hold requalified (non-blocking) findings, and the decision must be
          // re-derived over the BLOCKING subset — else suppressing the last blocking
          // finding leaves a stale approve_with_comments. With no requalifications
          // the two derivations are identical.
          decision: decisionAfterRequalification(output.decision, kept),
        };
      }
    }

    // The coordinator's summary was written against the pre-check finding set, so if
    // verification/suppression removed anything it can now reference issues that are
    // no longer listed. Reconcile the summary so it never contradicts the findings.
    // A decision change WITHOUT a count drop gets its own note: only requalification
    // does that — every finding is still listed, so the "removed" wording of the
    // count-drop note would be factually wrong there.
    const removedAfterChecks = findingCountBeforeChecks - output.findings.length;
    if (removedAfterChecks > 0) {
      output = { ...output, summary: reconcileSummary(output.summary, output.findings.length) };
    } else if (output.decision !== decisionBeforeChecks) {
      output = { ...output, summary: reconcileRequalifiedSummary(output.summary) };
    }

    // Carry a reviewer's grounded citations through a coordinator rewrite. A changed
    // fingerprint fails closed, so the engine never guesses which source applies.
    if (output.findings.length > 0) {
      output = {
        ...output,
        findings: output.findings.map((finding) => {
          const sources = mergeResearchSources(
            finding.sources,
            sourcesByFp.get(fingerprintFinding(finding)),
          );
          return sources.length > 0 ? { ...finding, sources } : finding;
        }),
      };
    }

    // Attribution: carry each surviving finding's originating agent onto the output. The
    // coordinator merges and rewrites findings, so match by fingerprint and keep the
    // first agent that produced it; a finding the coordinator changed enough to break the
    // fingerprint stays unattributed (reported as "unknown") rather than guessed. Agent
    // is excluded from the fingerprint, so setting it can never lapse a dismissal. This
    // lookup is the ONLY writer: the model-facing schema drops any `agent` the
    // coordinator emitted, so nothing here has to trust (or defer to) model attribution.
    // @ref LLP 0011#attribution-and-identity [implements] — attribution rides through the coordinator by fingerprint; annotation-only, and engine-set only
    if (agentByFp.size > 0 && output.findings.length > 0) {
      output = {
        ...output,
        findings: output.findings.map((finding) => {
          const agent = agentByFp.get(fingerprintFinding(finding));
          return agent ? { ...finding, agent } : finding;
        }),
      };
    }

    // Author-feedback adjudication (ships dark): when the caller supplied feedback input
    // and the mode is on, match the replies to the final findings and — in "adjudicate"
    // mode — judge each rebuttal against the source, then record the verdict and whether
    // it cleared the finding. Fails open: any error leaves the review untouched, so the
    // feedback path can never break a review (`ecr ci` must never fail a PR's checks).
    // @ref LLP 0011#the-rebuttal-is-a-hypothesis [implements] — runs after verification, before reporting; the hard floors and the cap live in adjudicate.ts, not the prompt
    let feedbackRecords: FeedbackRecord[] | undefined;
    if (options.feedback && options.feedback.config.mode !== "off") {
      try {
        const items = await options.feedback.match(output);
        const adjudication = await adjudicateFeedback(
          handle,
          items,
          options.feedback.config,
          progress,
          // The revision each verdict is judged against: the PR head OID this run
          // materialized and read from. A source without one (local git) stamps
          // nothing, so its verdicts never carry to a later run.
          metadata.headOid,
        );
        feedbackRecords = adjudication.records;
        agentCosts["adjudicator"] = adjudication.cost;
        trackTokens("adjudicator", adjudication.tokens);
        trackModel(
          "adjudicator",
          config.agents[0]?.model ?? config.coordinator.model,
          adjudication.model,
        );
        // Never silent: a capped or failed adjudication is a reduced-coverage fact.
        if (adjudication.skipped > 0 || adjudication.failed > 0) {
          const parts: string[] = [];
          if (adjudication.skipped > 0) {
            parts.push(
              `${adjudication.skipped} left unjudged over the maxAdjudications=${options.feedback.config.maxAdjudications} cap`,
            );
          }
          if (adjudication.failed > 0) {
            parts.push(`${adjudication.failed} could not be judged (the source check failed)`);
          }
          output = {
            ...output,
            incomplete: [
              ...new Set([
                ...output.incomplete,
                `Author-reply adjudication was reduced this run: ${parts.join("; ")}. ` +
                  `Those replies carry no verdict and cleared no finding.`,
              ]),
            ],
          };
        }
      } catch (error) {
        // Fail open — feedback never breaks a review.
        progress(
          `Author-reply adjudication failed (${errorMessage(error)}); continuing without it.`,
        );
      }
    }

    // Measure utility only after verification, suppression, citation carry-through,
    // and feedback adjudication have produced the final finding set. Counts use
    // unique audited URLs, not passages, so duplicate search hits cannot inflate them.
    if (researchRecord) {
      const usefulness = summarizeResearchUsefulness(researchRecord, output.findings);
      researchRecord = { ...researchRecord, usefulness };
      progress(formatResearchUsefulness(usefulness));
      await appendStepSummary(renderResearchUsefulnessMarkdown(researchRecord));
    }

    // Surface provider throttling as a fact about the run: passes already waited or
    // backed off, but the operator should still SEE that it happened (a run that
    // was rate-limited is slower and may carry partial passes — that's the cause).
    // Sum both engines' watches; name a cause only for an engine whose watch fired
    // (claude events arrive via note() in runClaudePrompt; opencode via its server log).
    await opencodeHandle?.rateLimit.check();
    const rlOpencode = opencodeHandle?.rateLimit.events ?? 0;
    const rlClaude = claudeHandle?.rateLimit.events ?? 0;
    const rlTotal = rlOpencode + rlClaude;
    if (rlTotal > 0) {
      const causes: string[] = [];
      if (rlClaude > 0) {
        causes.push("subscription rate/usage limits reported by the Claude Code CLI");
      }
      if (rlOpencode > 0) {
        causes.push("429s in the OpenCode server log");
      }
      progress(
        `  ⚠ provider rate-limited this run ${rlTotal} time(s) (${causes.join("; ")}) ` +
          `— passes waited it out rather than failing`,
      );
    }

    // Every pass says which model actually answered it — in the job log, the step
    // summary table, and the run log — so a wrong or substituted model is always
    // visible, not just when the substitution warning fires.
    if (Object.keys(agentModels).length > 0) {
      progress(
        `Models used — ${Object.entries(agentModels)
          .map(([bucket, model]) => `${bucket}: ${model}`)
          .join("; ")}`,
      );
    }
    progress(formatUsageSummary(tokenTotals, sum(agentCosts)));
    await appendStepSummary(
      renderUsageMarkdown(agentTokens, agentCosts, tokenTotals, sum(agentCosts), agentModels),
    );

    const reviewTrace = buildReviewTrace(agentTrace);
    await safeLog(logPath, {
      ...baseRecord,
      ...(researchRecord ? { research: researchRecord } : {}),
      agentCosts,
      totalCost: sum(agentCosts),
      tokens: tokenTotals,
      agentTokens,
      agentModels,
      agentFindings,
      reviewTrace,
      coverageNotes,
      verifierDropped,
      requalificationStrips,
      ...(rlTotal > 0
        ? {
            rateLimitEvents: rlTotal,
            rateLimitByEngine: { opencode: rlOpencode, claudeCode: rlClaude },
          }
        : {}),
      durationMs: Date.now() - started,
      decision: output.decision,
      findingCount: output.findings.length,
      summary: output.summary,
    });

    // Engine-owned: overwrite whatever the coordinator may have emitted under this key,
    // so setup advice is always the checker's, never model text.
    // `CoordinatorOutputSchema` knows the engine field so cached/embedded reviews can
    // parse it, but the coordinator must never author it. Strip any model-supplied
    // value and attach only the trace assembled from reviewer pass outputs.
    const outputWithTrace = attachReviewTrace(output, reviewTrace);
    const reviewed = {
      ...outputWithTrace,
      setupNotes,
    };
    return feedbackRecords ? { ...reviewed, feedback: feedbackRecords } : reviewed;
  } catch (error) {
    await safeLog(logPath, {
      ...baseRecord,
      ...(researchRecord ? { research: researchRecord } : {}),
      agentCosts,
      totalCost: sum(agentCosts),
      tokens: tokenTotals,
      agentTokens,
      agentFindings,
      reviewTrace: buildReviewTrace(agentTrace),
      durationMs: Date.now() - started,
      decision: null,
      findingCount: 0,
      summary: null,
      error: errorMessage(error),
    });
    throw error;
  } finally {
    handle.close();
    await auth.cleanup();
    await researchRuntime?.cleanup();
    await restoreCwd();
  }
}

export function mergeTraceNotes(
  target: Record<string, ReviewerTraceNotes>,
  agent: string,
  notes: ReviewerTraceNotes,
): void {
  const current = target[agent] ?? { checked: [], uncertainties: [] };
  const checked = [...new Set([...current.checked, ...notes.checked])].slice(
    0,
    REVIEW_TRACE_CHECKED_LIMIT,
  );
  const uncertainties = [...new Set([...current.uncertainties, ...notes.uncertainties])].slice(
    0,
    REVIEW_TRACE_UNCERTAINTY_LIMIT,
  );
  if (checked.length > 0 || uncertainties.length > 0) {
    target[agent] = { checked, uncertainties };
  }
}

export function buildReviewTrace(
  agents: Record<string, ReviewerTraceNotes>,
): ReviewTrace | undefined {
  // Sorting makes the cap deterministic even though concurrent passes finish in a
  // nondeterministic order. The byte ceiling protects GitHub's ~65k comment limit;
  // the trace shares that body with visible findings and their durable state.
  const entries = Object.entries(agents).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return undefined;
  }
  const kept = entries.slice(0, REVIEW_TRACE_AGENT_LIMIT);
  let truncatedAgents = entries.length - kept.length;
  for (;;) {
    const trace: ReviewTrace = {
      version: 1,
      trust: "unverified-model-diagnostics",
      agents: Object.fromEntries(kept),
      ...(truncatedAgents > 0 ? { truncatedAgents } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(trace), "utf8") <= REVIEW_TRACE_BYTES_LIMIT) {
      return trace;
    }
    if (kept.length === 0) {
      return undefined;
    }
    kept.pop();
    truncatedAgents++;
  }
}

/**
 * Replace any coordinator-authored trace with the engine-assembled value. The
 * coordinator reads untrusted PR data, so its output can never populate this hidden
 * machine-consumer channel even when it emits a locally schema-valid object.
 */
export function attachReviewTrace(
  output: CoordinatorOutput,
  reviewTrace: ReviewTrace | undefined,
): CoordinatorOutput {
  const { reviewTrace: _coordinatorTrace, ...withoutTrace } = output;
  return { ...withoutTrace, ...(reviewTrace ? { reviewTrace } : {}) };
}

/**
 * Policy backstop: strip the internal risk handoff, drop suggestions unless
 * opted in, cap by count (most severe first), and downgrade
 * approve_with_comments to approve when nothing remains.
 */
export function applyReviewPolicy(
  output: CoordinatorOutput,
  policy: LoadedConfig["policy"],
): CoordinatorOutput {
  // Unconditional, and before the severity filter: the handoff is `suggestion`-
  // severity, so `includeSuggestions: true` would otherwise publish it as a
  // finding whenever the coordinator forgot to strip it. It is prompt-authored
  // metadata for the coordinator's summary, never something an author should see.
  // @ref LLP 0009#prompt-rules-for-adopters [implements] — code-level strip, not prompt-only
  let findings = output.findings.filter((finding) => !isOverallRiskHandoff(finding));
  if (!policy.includeSuggestions) {
    findings = findings.filter((finding) => finding.severity !== "suggestion");
  }
  findings = sortFindings(findings);
  if (policy.maxFindings != null) {
    findings = findings.slice(0, policy.maxFindings);
  }
  const decision =
    output.decision === "approve_with_comments" && findings.length === 0
      ? "approve"
      : output.decision;
  return { ...output, findings, decision };
}

/**
 * Deterministic consolidation used when the coordinator step itself fails, so a
 * coordinator hiccup never discards the findings the agents already produced.
 * Merges + de-dupes (by fingerprint), applies the same policy, and picks a
 * conservative decision (never a clean approve when there are findings).
 */
// @ref LLP 0002#coordinator-and-degraded-decisions [implements] — coordinator failure must never discard already-collected findings
function fallbackConsolidation(
  agentFindings: Record<string, Finding[]>,
  policy: LoadedConfig["policy"],
): CoordinatorOutput {
  const seen = new Set<string>();
  const merged: Finding[] = [];
  for (const findings of Object.values(agentFindings)) {
    for (const finding of findings) {
      const key = fingerprintFinding(finding);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(finding);
      }
    }
  }
  const decision = merged.some((finding) => finding.severity === "critical")
    ? "request_changes"
    : merged.length > 0
      ? "approve_with_comments"
      : "approve";
  return applyReviewPolicy(
    {
      decision,
      findings: merged,
      summary:
        "Consolidation step failed; showing the specialist reviewers’ findings " +
        "merged and de-duplicated, but not re-judged.",
      incomplete: [],
    },
    policy,
  );
}

/**
 * Re-derive the decision after verification dropped findings: nothing left → approve;
 * a `request_changes` with no criticals remaining → soften to approve_with_comments;
 * otherwise keep the coordinator's decision.
 */
export function decisionAfterVerification(
  previous: CoordinatorOutput["decision"],
  kept: Finding[],
): CoordinatorOutput["decision"] {
  if (kept.length === 0) {
    return "approve";
  }
  if (previous === "request_changes" && !kept.some((finding) => finding.severity === "critical")) {
    return "approve_with_comments";
  }
  return previous;
}

/**
 * The normalized FILES where any reviewer emitted a critical, `secrets`, or `security`
 * finding PRE-coordination. This is the severity LOCK: no finding on such a file is
 * requalifiable, no matter what the coordinator later assigns it. Keyed on the file
 * alone — NOT a content fingerprint — because the coordinator legitimately
 * re-categorizes and paraphrases findings, and a fingerprint over those mutable
 * fields would let a downgraded-then-reworded critical dodge the lock. Over-locking
 * a whole file only keeps findings blocking (the feature's fail direction).
 * Exported for tests.
 */
// @ref LLP 0010#grounding-and-the-decision [implements] — pre-coordination file locks defeat downgrade-then-requalify
export function buildPreCoordinationFileLocks(
  agentFindings: Record<string, Finding[]>,
): Set<string> {
  const locked = new Set<string>();
  for (const findings of Object.values(agentFindings)) {
    for (const finding of findings) {
      if (
        finding.severity === "critical" ||
        finding.category === "secrets" ||
        finding.category === "security"
      ) {
        locked.add(normalizeManifestPath(finding.file));
      }
    }
  }
  return locked;
}

// @ref LLP 0010#grounding-and-the-decision [implements] — deterministic zero-LLM floor over data ecr fetched itself; strips forged/hallucinated/protected requalifications even with a prompt-injected coordinator
/**
 * Strip a finding's `requalifiedBy` (leaving the finding itself fully intact and
 * blocking) when any of these hold — every check is over data the coordinator cannot
 * influence:
 *  - the cited `(prNumber, file)` is not an EXACT normalized member of the fetched
 *    manifest (forged or hallucinated citation);
 *  - the finding is `critical` severity, or category `secrets` or `security`;
 *  - the finding's FILE carried a pre-coordination critical/secrets/security reviewer
 *    finding (severity lock — keyed on the file, so a coordinator re-categorization
 *    or paraphrase cannot dodge it).
 * Returns the grounded findings plus every stripped requalification (finding +
 * reason): a debug line covers the live stderr stream, and the caller persists the
 * strips to the run log (mirroring verifierDropped) so a silent under-fire stays
 * diagnosable after the run. Exported for tests.
 */
export function groundStackRequalification(
  findings: Finding[],
  manifest: StackManifest | null,
  lockedFiles: Set<string>,
  debug: (message: string) => void = () => {},
): { findings: Finding[]; stripped: { finding: Finding; reason: string }[] } {
  const members = manifest ? buildManifestMembership(manifest) : new Set<string>();
  const stripped: { finding: Finding; reason: string }[] = [];
  const grounded = findings.map((finding) => {
    const requalified = finding.requalifiedBy;
    if (!requalified) {
      return finding;
    }
    const strip = (reason: string): Finding => {
      debug(`Stack: stripped requalification on "${finding.file}" (${reason}).`);
      const { requalifiedBy: _dropped, ...rest } = finding;
      stripped.push({ finding: rest, reason });
      return rest;
    };
    if (finding.severity === "critical") {
      return strip("critical severity is never requalifiable");
    }
    if (finding.category === "secrets" || finding.category === "security") {
      return strip(`${finding.category} category is never requalifiable`);
    }
    if (lockedFiles.has(normalizeManifestPath(finding.file))) {
      return strip(
        "a reviewer emitted a critical/secrets/security finding on this file (severity lock)",
      );
    }
    if (!members.has(manifestKey(requalified.prNumber, requalified.file))) {
      return strip(
        `cited #${requalified.prNumber} "${requalified.file}" is not an exact manifest member`,
      );
    }
    return finding;
  });
  return { findings: grounded, stripped };
}

/**
 * Re-derive the decision after requalification over the still-BLOCKING (non-requalified)
 * findings only — the parallel of decisionAfterVerification. Requalified findings stay
 * shown and counted but never block: no blocking findings → approve; a request_changes
 * with no blocking critical left → soften to approve_with_comments. Exported for tests.
 */
// @ref LLP 0010#grounding-and-the-decision [implements] — decision is computed over the active subset, so a requalified warning stops blocking but stays visible
export function decisionAfterRequalification(
  previous: CoordinatorOutput["decision"],
  findings: Finding[],
): CoordinatorOutput["decision"] {
  const blocking = findings.filter((finding) => !finding.requalifiedBy);
  if (blocking.length === 0) {
    return "approve";
  }
  if (
    previous === "request_changes" &&
    !blocking.some((finding) => finding.severity === "critical")
  ) {
    return "approve_with_comments";
  }
  return previous;
}

/**
 * The grounding block's decision step: re-derive ONLY when a requalification
 * survived grounding. With none (the overwhelmingly common case — stack feature
 * off, or every requalification stripped), the incoming decision stands untouched:
 * re-deriving unconditionally would soften every non-critical request_changes on
 * every run, silently overriding the coordinator's (and any adopter rubric's)
 * decision policy. Exported for tests.
 */
export function decisionAfterGrounding(
  previous: CoordinatorOutput["decision"],
  findings: Finding[],
): CoordinatorOutput["decision"] {
  return findings.some((finding) => finding.requalifiedBy)
    ? decisionAfterRequalification(previous, findings)
    : previous;
}

/**
 * The coordinator writes its summary before findings are verified/suppressed, so a
 * post-coordination drop can leave the summary referencing issues no longer shown.
 * Reconcile without a second LLM call: if everything was removed, replace it;
 * otherwise prepend a short honest caveat so the prose can't be read as
 * contradicting the (accurate) findings list below it.
 */
export function reconcileSummary(summary: string, remaining: number): string {
  if (remaining === 0) {
    return "All candidate findings were removed by automated verification and suppression, so no issues remain to report.";
  }
  return (
    "_Note: some findings were removed by automated verification/suppression after " +
    "this summary was written, so it may mention issues no longer listed below._\n\n" +
    summary
  );
}

/**
 * The decision-changed-without-removal reconcile: requalification softened the
 * decision while keeping every finding listed, so the summary prose (written before
 * grounding ran) can read stricter than the final decision. Nothing was removed —
 * the note must not claim it was. Exported for tests.
 */
export function reconcileRequalifiedSummary(summary: string): string {
  return (
    "_Note: after this summary was written, some findings were requalified as " +
    "addressed in stacked PRs — they are still listed below but no longer block, " +
    "so the prose may read stricter than the final decision._\n\n" +
    summary
  );
}

/**
 * Resolve the tree the review reads from, applying the mode's trust policy:
 *
 * - `null` from the source means "nothing to materialize" — reviewing the current
 *   checkout is intended (local diffs, or `--pr` without a repo). Never an error.
 * - A materialization FAILURE (throw) is fatal in CI: the checkout there is the
 *   trusted BASE tree, and falling back to it would silently review and verify
 *   pre-PR file contents (dropping real findings with no trace in the output).
 *   The throw propagates to `ecr ci`'s catch, which posts the one terminal
 *   "not reviewed" comment.
 * - The same failure in local mode degrades softly to the user's own checkout —
 *   the user is the trust principal there and sees the warning directly.
 *
 * Exported for tests.
 */
export async function resolveReadRoot(
  source: ReviewSource,
  mode: ReviewRunOptions["mode"],
  progress: (message: string) => void,
): Promise<PreparedReadRoot | null> {
  if (!source.prepareReadRootAsync) {
    return null;
  }
  try {
    return await source.prepareReadRootAsync();
  } catch (error) {
    if (mode === "ci") {
      throw new Error(
        `Could not materialize the PR-head tree to review (and the CI checkout is the ` +
          `trusted base, so reviewing it instead would silently review the wrong ` +
          `contents): ${errorMessage(error)}`,
      );
    }
    progress(
      `Could not materialize the PR-head tree (${errorMessage(error)}); ` +
        `reading the current checkout instead — file contents may not match the PR.`,
    );
    return null;
  }
}

/** Capitalize the first letter (coverage notes read as sentences). */
function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * An authentication/authorization failure from the model provider (401/403, a
 * rejected/expired/missing credential) — distinct from a transient blip or a real
 * code finding. Every pass hits the same wall, so the caller collapses it into one
 * actionable coverage note instead of N generic "failed to run" lines.
 */
export function isAuthError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const cred = /(api.?key|token|credential)/;
  const problem = /(invalid|expired|revoked|missing|rejected|no)/;
  return (
    /\b401\b|\b403\b/.test(message) ||
    /unauthor/.test(message) ||
    /\bforbidden\b/.test(message) ||
    /authentication/.test(message) ||
    /permission denied/.test(message) ||
    /invalid x-api-key/.test(message) ||
    // a credential noun and a problem word near each other, in either order
    new RegExp(`${problem.source}\\b[^.]{0,20}${cred.source}`).test(message) ||
    new RegExp(`${cred.source}[^.]{0,20}${problem.source}`).test(message)
  );
}

const AUTH_FAILURE_NOTE =
  "The model provider rejected the request (authentication or permission). Check the " +
  "configured credential (auth.tokenEnv, or REVIEWER_MODEL for a local run) and re-run — " +
  "those changes were not reviewed.";

function selectAgents(all: LoadedAgent[], filter?: string[]): LoadedAgent[] {
  if (!filter?.length) {
    return all;
  }
  const known = new Set(all.map((agent) => agent.id));
  const unknown = filter.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown agent(s): ${unknown.join(", ")}. Available: ${all.map((a) => a.id).join(", ")}`,
    );
  }
  return all.filter((agent) => filter.includes(agent.id));
}

/**
 * Greedily pack files into chunks bounded by total changed lines (primary) and
 * file count (secondary guard). A single file larger than maxChangedLines becomes
 * its own chunk (a file is never split).
 */
export function chunkByLines(
  files: PatchWorkspaceFile[],
  maxChangedLines: number,
  maxFiles: number,
): PatchWorkspaceFile[][] {
  const chunks: PatchWorkspaceFile[][] = [];
  let current: PatchWorkspaceFile[] = [];
  let lines = 0;
  for (const file of files) {
    const wouldOverflow = lines + file.changedLines > maxChangedLines;
    if (current.length > 0 && (wouldOverflow || current.length >= maxFiles)) {
      chunks.push(current);
      current = [];
      lines = 0;
    }
    current.push(file);
    lines += file.changedLines;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

const QUEUE_IDLE_POLL_MS = 100;

/**
 * Run tasks with at most `limit` in flight, from a queue that workers may GROW
 * while running: a timed-out chunk enqueues smaller sub-tasks, which free workers
 * then pick up. Workers stay alive until the queue is empty AND no worker is still
 * running (a running worker might yet enqueue more), so dynamically-added work is
 * never lost. `fn` receives the item and an `enqueue` callback.
 */
// @ref LLP 0002#timeouts-stalls-and-subdivision [implements] — terminates on active===0, not queue-empty, so growth mid-drain isn't lost
export async function runGrowableQueue<T>(
  initial: T[],
  limit: number,
  fn: (item: T, enqueue: (next: T) => void) => Promise<void>,
): Promise<void> {
  const queue: T[] = [...initial];
  let active = 0;
  const enqueue = (next: T): void => {
    queue.push(next);
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) {
        // Nothing queued: done only once no other worker is still running (which
        // could enqueue more); otherwise wait briefly and re-check.
        if (active === 0) {
          return;
        }
        await sleep(QUEUE_IDLE_POLL_MS);
        continue;
      }
      active++;
      try {
        await fn(item, enqueue);
      } finally {
        active--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
}

function sum(costs: Record<string, number>): number {
  return Object.values(costs).reduce((total, value) => total + value, 0);
}

/**
 * One-line usage summary for the run. Emitted via progress so it lands in the CI
 * job log (and the local terminal) — `.runs/reviews.jsonl` is ephemeral in CI, so
 * this is the only place the token/cache totals are visible after a CI run, which
 * is how prompt-cache effectiveness gets confirmed there.
 */
export function formatUsageSummary(tokens: TokenUsage, totalCost: number): string {
  const parts = [`input ${tokens.input ?? 0}`, `output ${tokens.output ?? 0}`];
  if (tokens.reasoning) {
    parts.push(`reasoning ${tokens.reasoning}`);
  }
  parts.push(`cache read ${tokens.cache?.read ?? 0}`, `cache write ${tokens.cache?.write ?? 0}`);
  const cost = totalCost > 0 ? ` (cost $${totalCost.toFixed(4)})` : "";
  return `Token usage — ${parts.join(", ")}${cost}`;
}

/**
 * Markdown-table version of the usage summary for the Actions step summary: one
 * row per pass plus a total, and the prompt-cache hit rate (the share of prompt
 * tokens served from cache instead of being reprocessed at full price).
 */
export function renderUsageMarkdown(
  agentTokens: Record<string, TokenUsage>,
  agentCosts: Record<string, number>,
  totals: TokenUsage,
  totalCost: number,
  agentModels: Record<string, string> = {},
): string {
  const row = (label: string, model: string, tokens: TokenUsage, cost: number): string =>
    `| ${label} | ${model} | ${tokens.input ?? 0} | ${tokens.output ?? 0} | ${tokens.cache?.read ?? 0} | ${tokens.cache?.write ?? 0} | $${cost.toFixed(4)} |`;
  const lines = [
    "### 🤖 AI review — token usage",
    "",
    "| pass | model | input | output | cache read | cache write | cost |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.keys(agentCosts).map((bucket) =>
      row(bucket, agentModels[bucket] ?? "—", agentTokens[bucket] ?? {}, agentCosts[bucket] ?? 0),
    ),
    row("**total**", "", totals, totalCost),
  ];
  const read = totals.cache?.read ?? 0;
  const uncached = totals.input ?? 0;
  if (read + uncached > 0) {
    const rate = Math.round((read / (read + uncached)) * 100);
    lines.push(
      "",
      `Prompt cache hit rate: **${rate}%** (cache read / (cache read + input)). ` +
        'See "Tokens, cost & prompt caching" in the README for how to read these numbers.',
    );
  }
  return lines.join("\n");
}

async function safeLog(logPath: string, record: RunLogRecord): Promise<void> {
  try {
    await writeRunLog(logPath, record);
  } catch {
    // Logging must never break a review.
  }
}
