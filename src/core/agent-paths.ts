// @ref LLP 0002#agent-paths-filter [implements] — run-level then chunk-level `paths` filter; an explicit agent list bypasses both
import type { LoadedAgent } from "../config/schema.js";
import { matchesPathGlobs } from "../config/routing.js";

/** True when the agent declares no `paths`, or one of its globs matches one of `files`. */
export function agentMatchesFiles(
  agent: Pick<LoadedAgent, "paths">,
  files: readonly string[],
): boolean {
  const globs = agent.paths;
  if (!globs) {
    return true;
  }
  return files.some((file) => matchesPathGlobs(globs, file));
}

export interface AgentPathsSelection {
  /** The agents this run reviews with, in roster order. */
  agents: LoadedAgent[];
  /** Ids of the roster agents whose `paths` match none of the files. */
  skipped: string[];
}

/**
 * Apply the `paths` filter to a run's reviewable files. An explicit agent list is
 * returned unchanged: the caller asked for those agents by name.
 */
export function selectAgentsByPaths(
  roster: LoadedAgent[],
  files: readonly string[],
  explicit: LoadedAgent[] | null,
): AgentPathsSelection {
  if (explicit) {
    return { agents: explicit, skipped: [] };
  }
  const agents: LoadedAgent[] = [];
  const skipped: string[] = [];
  for (const agent of roster) {
    if (agentMatchesFiles(agent, files)) {
      agents.push(agent);
    } else {
      skipped.push(agent.id);
    }
  }
  return { agents, skipped };
}

/**
 * Split chunk indices (0-based) into the ones the agent reviews and the ones it
 * skips because no file in them matches its `paths`. A reviewed chunk is reviewed
 * whole. `explicit` (the agent was named in an explicit list) reviews every chunk.
 */
export function planAgentChunks(
  agent: Pick<LoadedAgent, "paths">,
  chunks: ReadonlyArray<ReadonlyArray<{ path: string }>>,
  explicit: boolean,
): { run: number[]; skipped: number[] } {
  const run: number[] = [];
  const skipped: number[] = [];
  chunks.forEach((chunk, index) => {
    const reviews =
      explicit ||
      agentMatchesFiles(
        agent,
        chunk.map((file) => file.path),
      );
    (reviews ? run : skipped).push(index);
  });
  return { run, skipped };
}

/** What the `paths` filter left out of one run. */
export interface PathsSkips {
  /** Agents skipped for the whole run. */
  agents: string[];
  /** For agents that ran: the 1-based numbers of the chunks they skipped. */
  parts: Record<string, number[]>;
  /** The run's chunk count; 0 when the run ended before the diff was chunked. */
  chunks: number;
}

/** True when the filter skipped any agent or chunk. */
export function hasPathsSkips(skips: PathsSkips): boolean {
  return skips.agents.length > 0 || Object.keys(skips.parts).length > 0;
}

/** The job-log line for agents skipped for the whole run; empty when there are none. */
export function formatSkippedAgents(skips: PathsSkips): string[] {
  return skips.agents.length > 0
    ? [
        `Skipping agent(s) whose \`paths\` match no reviewable file (no model call): ${skips.agents.join(", ")}.`,
      ]
    : [];
}

/** Job-log lines for agents that skipped some chunks, one line per agent. */
export function formatSkippedParts(skips: PathsSkips): string[] {
  return Object.entries(skips.parts).map(
    ([agent, parts]) =>
      `Skipping ${agent} on part(s) ${parts.join(", ")} of ${skips.chunks}: no file there matches its \`paths\`.`,
  );
}

/** Step-summary markdown for the skips; empty when nothing was skipped. */
export function renderPathsSkipsMarkdown(skips: PathsSkips): string {
  if (!hasPathsSkips(skips)) {
    return "";
  }
  const rows = [
    ...skips.agents.map(
      (agent) => `| ${agent} | the whole review: no reviewable file matches its \`paths\` |`,
    ),
    ...Object.entries(skips.parts).map(
      ([agent, parts]) =>
        `| ${agent} | part(s) ${parts.join(", ")} of ${skips.chunks}: no file there matches its \`paths\` |`,
    ),
  ];
  return [
    "### 🤖 AI review: agents skipped by `paths`",
    "",
    "| agent | skipped |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}
