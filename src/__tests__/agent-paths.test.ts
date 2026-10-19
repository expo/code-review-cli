import { test, expect } from "bun:test";

import {
  agentMatchesFiles,
  formatSkippedAgents,
  formatSkippedParts,
  planAgentChunks,
  renderPathsSkipsMarkdown,
  selectAgentsByPaths,
} from "../core/agent-paths.js";
import type { LoadedAgent } from "../config/schema.js";

const agent = (id: string, over: Partial<LoadedAgent> = {}): LoadedAgent => ({
  id,
  description: `${id} agent`,
  alwaysRun: false,
  model: "anthropic/claude-sonnet-5",
  temperature: 0.1,
  tools: { read: true },
  promptText: id,
  ...over,
});

const ios = agent("ios", { paths: ["packages/ios/**", "**/*.swift"] });
const docs = agent("docs", { paths: ["docs/**"] });
const correctness = agent("correctness");

test("agentMatchesFiles: no `paths` matches everything; globs use the routing dialect", () => {
  expect(agentMatchesFiles(correctness, [])).toBe(true);
  expect(agentMatchesFiles(ios, ["packages/ios/src/a.ts"])).toBe(true);
  // `**/` also matches at the repo root, as it does in routing.jsonc.
  expect(agentMatchesFiles(ios, ["App.swift"])).toBe(true);
  expect(agentMatchesFiles(ios, ["packages/android/a.kt", "README.md"])).toBe(false);
});

test("selectAgentsByPaths: drops agents whose paths match no reviewable file", () => {
  const selection = selectAgentsByPaths([correctness, docs, ios], ["packages/ios/a.ts"], null);
  expect(selection.agents.map((a) => a.id)).toEqual(["correctness", "ios"]);
  expect(selection.skipped).toEqual(["docs"]);
});

test("selectAgentsByPaths: with no `paths` anywhere the roster is returned as is", () => {
  const roster = [correctness, agent("security", { alwaysRun: true })];
  const selection = selectAgentsByPaths(roster, ["anything.ts"], null);
  expect(selection.agents).toEqual(roster);
  expect(selection.skipped).toEqual([]);
});

test("selectAgentsByPaths: an alwaysRun agent is skipped when its paths match nothing", () => {
  const guard = agent("guard", { alwaysRun: true, paths: ["infra/**"] });
  const selection = selectAgentsByPaths([correctness, guard], ["src/a.ts"], null);
  expect(selection.agents.map((a) => a.id)).toEqual(["correctness"]);
  expect(selection.skipped).toEqual(["guard"]);
});

test("selectAgentsByPaths: an explicit agent list runs even when its paths match nothing", () => {
  const selection = selectAgentsByPaths([correctness, docs, ios], ["src/a.ts"], [docs]);
  expect(selection.agents).toEqual([docs]);
  expect(selection.skipped).toEqual([]);
});

const chunk = (...paths: string[]): Array<{ path: string }> => paths.map((p) => ({ path: p }));
const chunks = [
  chunk("packages/ios/a.ts", ".changeset/x.md"),
  chunk("packages/web/b.ts"),
  chunk("packages/web/c.ts", "packages/ios/d.swift"),
];

test("planAgentChunks: skips chunks with no matching file and keeps whole chunks", () => {
  expect(planAgentChunks(ios, chunks, false)).toEqual({ run: [0, 2], skipped: [1] });
  expect(planAgentChunks(correctness, chunks, false)).toEqual({ run: [0, 1, 2], skipped: [] });
});

test("planAgentChunks: an explicit agent list reviews every chunk", () => {
  expect(planAgentChunks(docs, chunks, true)).toEqual({ run: [0, 1, 2], skipped: [] });
});

test("skip formatters name run- and chunk-level skips", () => {
  const skips = { agents: ["docs"], parts: { ios: [2] }, chunks: 3 };
  expect(formatSkippedAgents(skips)).toEqual([
    "Skipping agent(s) whose `paths` match no reviewable file (no model call): docs.",
  ]);
  expect(formatSkippedParts(skips)).toEqual([
    "Skipping ios on part(s) 2 of 3: no file there matches its `paths`.",
  ]);
  const markdown = renderPathsSkipsMarkdown(skips);
  expect(markdown).toContain("agents skipped by `paths`");
  expect(markdown).toContain("| docs | the whole review: no reviewable file matches its `paths` |");
  expect(markdown).toContain("| ios | part(s) 2 of 3: no file there matches its `paths` |");
});

test("skip formatters are empty when nothing was skipped", () => {
  const none = { agents: [], parts: {}, chunks: 1 };
  expect(formatSkippedAgents(none)).toEqual([]);
  expect(formatSkippedParts(none)).toEqual([]);
  expect(renderPathsSkipsMarkdown(none)).toBe("");
});
