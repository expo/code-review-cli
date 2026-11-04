import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_DIRNAME, loadReviewConfig } from "../config/load.js";
import { buildAgentSummaries, runWithPreCheck } from "../core/review.js";

const task = (bucket: string) => ({ bucket });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ecr-pre-check-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRootConfig(config: unknown): Promise<void> {
  const dir = path.join(root, CONFIG_DIRNAME);
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), JSON.stringify(config));
  await writeFile(path.join(dir, "coordinator.md"), "Coordinator.");
  await writeFile(path.join(dir, "agents", "shape.md"), "Shape.");
  await writeFile(path.join(dir, "agents", "deep.md"), "Deep.");
}

test("runWithPreCheck runs every task in one wave when no agent is a pre-check", async () => {
  const waves: string[][] = [];
  const result = await runWithPreCheck(
    [task("shape"), task("deep")],
    [],
    async (tasks) => {
      waves.push(tasks.map((t) => t.bucket));
    },
    async () => true,
  );
  expect(waves).toEqual([["shape", "deep"]]);
  expect(result.stoppedBy).toEqual([]);
});

test("runWithPreCheck runs the pre-check first, then the rest when it confirms no critical", async () => {
  const waves: string[][] = [];
  const result = await runWithPreCheck(
    [task("deep"), task("shape"), task("cross-cutting")],
    ["shape"],
    async (tasks) => {
      waves.push(tasks.map((t) => t.bucket));
    },
    async () => false,
  );
  expect(waves).toEqual([["shape"], ["deep", "cross-cutting"]]);
  expect(result.stoppedBy).toEqual([]);
});

test("runWithPreCheck skips the rest when the pre-check confirms a critical", async () => {
  const waves: string[][] = [];
  let checked: string[] = [];
  const result = await runWithPreCheck(
    [task("deep"), task("shape")],
    ["shape"],
    async (tasks) => {
      waves.push(tasks.map((t) => t.bucket));
    },
    async (agents) => {
      checked = agents;
      return true;
    },
  );
  expect(waves).toEqual([["shape"]]);
  expect(checked).toEqual(["shape"]);
  expect(result.stoppedBy).toEqual(["shape"]);
});

test("buildAgentSummaries marks the agents a pre-check stopped as not run", () => {
  const rows = buildAgentSummaries({
    ran: ["shape"],
    summaries: new Map(),
    skippedByPaths: [],
    notRouted: [],
    skippedByPreCheck: ["deep"],
  });
  expect(rows).toEqual([{ agent: "shape" }, { agent: "deep", notRun: "preCheck" }]);
});

test("loads preCheckAgents that name agents in the roster", async () => {
  await writeRootConfig({ preCheckAgents: ["shape"] });
  expect((await loadReviewConfig(root)).preCheckAgents).toEqual(["shape"]);
});

test("refuses a preCheckAgents id that is not an agent", async () => {
  await writeRootConfig({ preCheckAgents: ["shap"] });
  await expect(loadReviewConfig(root)).rejects.toThrow(/preCheckAgents.*"shap"/);
});
