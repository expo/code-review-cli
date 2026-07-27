import path from "node:path";

import type { LoadedAgent, LoadedConfig } from "../config/schema.js";
import type { PreparedReadRoot, ReviewSource } from "../sources/source.js";
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
  CROSS_CUTTING_AGENT,
  promptAndParse,
  startOpencode,
} from "./opencode.js";
import type { OpencodeHandle, TokenUsage } from "./opencode.js";
import { routeAgents } from "./router.js";
import {
  buildCrossCuttingSystem,
  buildCrossCuttingTask,
  buildReviewerSystem,
  buildReviewerTask,
  NO_TOOLS_INSTRUCTION,
} from "./prompts.js";
import { fingerprintFinding, parseReviewerOutput } from "./schema.js";
import type { CoordinatorOutput, Finding } from "./schema.js";
import { sortFindings } from "./render.js";
import { appendStepSummary } from "./step-summary.js";
import { errorMessage, sleep } from "./util.js";
import { verifyFindings } from "./verify.js";
import { applyInlineIgnores } from "./suppress.js";

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
 * Max concurrent reviewer calls: an explicit config value wins; otherwise 3 when a
 * subscription (oauth) credential is configured, else 6. One ChatGPT account
 * handles six parallel streams poorly — requests get parked server-side (the
 * stall signature seen on eas-cli#4084), and several PRs may be reviewing on the
 * same credential at once — so subscription runs trade a little wall-clock for a
 * lot of reliability. Exported for tests.
 */
export function effectiveConcurrency(config: LoadedConfig): number {
  if (config.chunk.concurrency) {
    return config.chunk.concurrency;
  }
  return config.auth.some((entry) => entry.mode === "oauth") ? 3 : 6;
}

export async function runReview(
  source: ReviewSource,
  options: ReviewRunOptions,
): Promise<CoordinatorOutput> {
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

  const [metadata, changedFiles] = await Promise.all([
    source.getMetadata(),
    source.getChangedFiles(),
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

  // Materialize the PR-head tree (not the current checkout) when the source can, so
  // the agents' surrounding-source reads and the verifier's re-reads see the versions
  // that match the diff. Config is already fully loaded in memory, so the chdir below
  // doesn't affect it; run-log/patch paths are absolute; gh/git calls already ran
  // above. Failure policy is MODE-DEPENDENT (see resolveReadRoot): CI fails closed —
  // with a base-SHA checkout the fallback tree is pre-PR content, and silently
  // reviewing/verifying that drops real findings — while a local run falls back to
  // the user's own checkout with a warning.
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

  progress("Starting OpenCode server…");
  let handle: OpencodeHandle | null = null;
  try {
    handle = await startOpencode(buildOpencodeConfig(config));
  } catch (error) {
    await auth.cleanup();
    await restoreCwd();
    throw new Error(
      `Failed to start the OpenCode server. Ensure the \`opencode\` CLI is installed and ` +
        `model credentials are configured (\`ecr doctor\` checks both).\n${errorMessage(error)}`,
    );
  }

  // Preflight: a model id the server can't resolve would otherwise fail EVERY pass
  // identically — N indistinguishable coverage gaps, after spending the run's budget
  // discovering the same fixable thing N times. Throw once, up front, naming the fix.
  try {
    await assertModelsResolvable(
      handle,
      [...config.agents.map((agent) => agent.model), config.coordinator.model],
      config.auth,
    );
  } catch (error) {
    handle.close();
    await auth.cleanup();
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
  const trackModel = (bucket: string, configured: string, actual?: string): void => {
    if (!actual) {
      return;
    }
    agentModels[bucket] = actual;
    if (configured && actual !== configured) {
      substituted.add(`${bucket}: configured ${configured}, ran ${actual}`);
    }
  };

  try {
    const workspace = await writePatchWorkspace(kept, metadata, runDir);

    // Resolve which agents run: an explicit list wins; otherwise route (LLM picks
    // relevant agents + always-run) when asked, else all.
    let selectedAgents = explicitAgents ?? config.agents;
    if (!explicitAgents && options.route) {
      progress("Routing: selecting relevant agents…");
      const routed = await routeAgents(handle!, config, workspace.files);
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
          ? buildCrossCuttingTask(task.files, selectedAgents, filtered, {
              noTools: task.fallback,
            })
          : buildReviewerTask(task.files, workspace.files, filtered);
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
    // promptAndParse already retries internally (same-session corrective, then a
    // bounded fresh session). We do NOT wrap it in another retry loop. On a genuine
    // TIMEOUT, instead of dropping the work we break it into units that converge:
    // subdivide the chunk, then a fast no-tools pass, and only report a coverage gap
    // when even that can't finish inside the budget — so dropped work is never silent.
    await runGrowableQueue(tasks, concurrency, async (task, enqueue) => {
      const minutes = Math.round(task.maxWaitMs / 60000);
      try {
        const { value, cost, truncated, tokens, model } = await promptAndParse(
          handle!,
          {
            agent: task.bucket,
            system: task.system,
            text: buildTaskText(task),
            title: task.title,
            onActivity: (line) => progress(`  ${task.label}: ${line}`),
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
        completedPasses++;
        if (truncated) {
          progress(`  ${task.label}: hit its budget — returned partial findings`);
          incomplete.push(
            `${capitalize(task.coverageLabel)} ran out of time; its findings may be incomplete.`,
          );
        }
        return;
      } catch (error) {
        // Non-timeout errors are genuine failures — record and move on.
        if (!(error instanceof AgentTimeoutError)) {
          failedPasses++;
          progress(`  ${task.label}: FAILED (${errorMessage(error)})`);
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
          progress(
            `  ${task.label}: exceeded ${minutes}m — splitting into 2 smaller passes (${left.length} + ${right.length} files)`,
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
          progress(
            `  ${task.label}: exceeded ${minutes}m — retrying ${filesLabel(task.files)} with a fast no-tools pass`,
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
          progress(
            `  ${task.label}: its model requests went silent (stalled) and did not recover — ` +
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
          progress(
            `  ${task.label}: exceeded ${minutes}m and the run's time budget is spent — reporting a coverage gap`,
          );
          incomplete.push(
            `${capitalize(task.coverageLabel)} timed out and the overall review budget was exhausted before it could be broken down further; those changes were not fully reviewed.`,
          );
        } else {
          progress(
            `  ${task.label}: exceeded ${minutes}m even at its smallest reviewable unit — reporting a coverage gap`,
          );
          incomplete.push(
            `${capitalize(task.coverageLabel)} exceeded its time budget even after being reduced to its smallest reviewable unit; those changes were not fully reviewed.`,
          );
        }
      }
    });

    // A substituted model means the review did not run on the model this repo
    // configured — the findings may be from a weaker (or free-tier) model entirely.
    // Never silent: it goes to the log, the coverage notes, and the run log.
    if (substituted.size > 0) {
      for (const line of substituted) {
        progress(`  ⚠ model substituted — ${line}`);
      }
      incomplete.push(
        `Some passes did not run on the configured model (${[...substituted].join("; ")}). ` +
          `OpenCode silently falls back to a default model when the configured id is empty or ` +
          `unusable, so these findings may come from a different (possibly much weaker) model ` +
          `than intended — check the agents' \`model\`, \`coordinator.model\`, REVIEWER_MODEL, and the provider credential.`,
      );
    }

    // Note: routine noise filtering (lockfiles, generated, binary) is expected and
    // NOT a coverage gap — it stays in the run log (filteredFiles), not the
    // user-facing coverage note, which is reserved for passes that didn't finish.
    const coverageNotes = [...new Set(incomplete)];

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
        } = await coordinate(handle, config, metadata, agentFindings, coverageNotes);
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

    // Guard against hallucinated findings before surfacing: quote-ground every
    // finding against the real file, and adversarially verify criticals. This is
    // what stops a confident but wrong critical from shipping.
    const findingCountBeforeChecks = output.findings.length;
    let verifierDropped: { finding: Finding; reason: string }[] = [];
    if (output.findings.length > 0) {
      progress("Verifying findings…");
      const verification = await verifyFindings(handle!, output.findings, process.cwd(), progress);
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
          decision: decisionAfterVerification(output.decision, kept),
        };
      }
    }

    // The coordinator's summary was written against the pre-check finding set, so if
    // verification/suppression removed anything it can now reference issues that are
    // no longer listed. Reconcile the summary so it never contradicts the findings.
    const removedAfterChecks = findingCountBeforeChecks - output.findings.length;
    if (removedAfterChecks > 0) {
      output = { ...output, summary: reconcileSummary(output.summary, output.findings.length) };
    }

    // Surface provider throttling as a fact about the run: passes already waited or
    // backed off, but the operator should still SEE that it happened (a run that
    // was rate-limited is slower and may carry partial passes — that's the cause).
    await handle!.rateLimit.check();
    if (handle!.rateLimit.events > 0) {
      progress(
        `  ⚠ provider rate-limited this run ${handle!.rateLimit.events} time(s) ` +
          `(429s in the OpenCode server log) — passes waited it out rather than failing`,
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

    await safeLog(logPath, {
      ...baseRecord,
      agentCosts,
      totalCost: sum(agentCosts),
      tokens: tokenTotals,
      agentTokens,
      agentModels,
      agentFindings,
      coverageNotes,
      verifierDropped,
      ...(handle!.rateLimit.events > 0 ? { rateLimitEvents: handle!.rateLimit.events } : {}),
      durationMs: Date.now() - started,
      decision: output.decision,
      findingCount: output.findings.length,
      summary: output.summary,
    });

    return output;
  } catch (error) {
    await safeLog(logPath, {
      ...baseRecord,
      agentCosts,
      totalCost: sum(agentCosts),
      tokens: tokenTotals,
      agentTokens,
      agentFindings,
      durationMs: Date.now() - started,
      decision: null,
      findingCount: 0,
      summary: null,
      error: errorMessage(error),
    });
    throw error;
  } finally {
    handle?.close();
    await auth.cleanup();
    await restoreCwd();
  }
}

/**
 * Policy backstop: drop suggestions unless opted in, cap by count (most severe
 * first), and downgrade approve_with_comments to approve when nothing remains.
 */
export function applyReviewPolicy(
  output: CoordinatorOutput,
  policy: LoadedConfig["policy"],
): CoordinatorOutput {
  let findings = policy.includeSuggestions
    ? output.findings
    : output.findings.filter((finding) => finding.severity !== "suggestion");
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
