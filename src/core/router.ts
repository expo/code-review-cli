// @ref LLP 0002#pipeline-stages [implements] — routing needs a live engine handle, so it runs after engine startup, not before
import type { LoadedAgent } from "../config/schema.js";
import type { PatchWorkspaceFile } from "./noise.js";
import { promptAndParse } from "./opencode.js";
import type { OpencodeHandle } from "./opencode.js";
import { buildRouterSystem, buildRouterTask } from "./prompts.js";
import { parseRouteOutput } from "./schema.js";

export interface RouteResult {
  agents: LoadedAgent[];
  /** True if the router chose the set; false means we fell back to all candidates. */
  routed: boolean;
}

/**
 * Ask the model which of the candidate agents are relevant to the changed files.
 * Candidates marked `alwaysRun` are unioned in regardless. Falls back to ALL
 * candidates if the router returns nothing usable or errors, because a review must
 * never run with zero agents. The caller passes the agents whose `paths` match.
 */
// @ref LLP 0002#agent-paths-filter [implements] — the router and alwaysRun only ever see the agents the paths filter kept
export async function routeAgents(
  handle: OpencodeHandle,
  candidates: LoadedAgent[],
  files: PatchWorkspaceFile[],
  onActivity?: (line: string) => void,
): Promise<RouteResult> {
  try {
    const { value } = await promptAndParse(
      handle,
      {
        agent: "coordinator",
        system: buildRouterSystem(),
        text: buildRouterTask(candidates, files),
        title: "route",
        onActivity,
      },
      parseRouteOutput,
    );
    return pickRoutedAgents(candidates, value.agents);
  } catch {
    return { agents: candidates, routed: false };
  }
}

/**
 * The routed set: the picked ids that are candidates, plus every `alwaysRun`
 * candidate, in candidate order. Falls back to all candidates when that is empty.
 */
export function pickRoutedAgents(candidates: LoadedAgent[], pickedIds: string[]): RouteResult {
  const picked = new Set(pickedIds);
  const chosen = candidates.filter((agent) => agent.alwaysRun || picked.has(agent.id));
  if (chosen.length === 0) {
    return { agents: candidates, routed: false };
  }
  return { agents: chosen, routed: true };
}
