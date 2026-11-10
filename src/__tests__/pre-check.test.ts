import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_DIRNAME, loadReviewConfig } from "../config/load.js";
import { attachPreCheckStop, buildAgentSummaries, runWithPreCheck } from "../core/review.js";
import type { CoordinatorOutput } from "../core/schema.js";

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
    async () => ["shape"],
  );
  expect(waves).toEqual([["shape", "deep"]]);
  expect(result.stoppedBy).toEqual([]);
});

test("runWithPreCheck runs the pre-check first, then the rest when it confirms no critical", async () => {
  const waves: Array<[string[], boolean]> = [];
  const result = await runWithPreCheck(
    [task("deep"), task("shape"), task("cross-cutting")],
    ["shape"],
    async (tasks, secondWave) => {
      waves.push([tasks.map((t) => t.bucket), secondWave]);
    },
    async () => [],
  );
  expect(waves).toEqual([
    [["shape"], false],
    [["deep", "cross-cutting"], true],
  ]);
  expect(result.stoppedBy).toEqual([]);
});

test("runWithPreCheck skips the rest when the pre-check confirms a critical", async () => {
  const waves: string[][] = [];
  let checked: string[] = [];
  const result = await runWithPreCheck(
    [task("deep"), task("shape"), task("lint"), task("cross-cutting")],
    ["shape", "lint"],
    async (tasks) => {
      waves.push(tasks.map((t) => t.bucket));
    },
    async (agents) => {
      checked = agents;
      return ["shape"];
    },
  );
  expect(waves).toEqual([["shape", "lint"]]);
  expect(checked).toEqual(["shape", "lint"]);
  // Only the agent whose critical was confirmed is named, and the cross-file pass counts.
  expect(result).toEqual({ stoppedBy: ["shape"], skipped: ["deep", "cross-cutting"] });
});

test("runWithPreCheck does not verify or stop when nothing would be skipped", async () => {
  let verified = false;
  const result = await runWithPreCheck(
    [task("shape")],
    ["shape"],
    async () => {},
    async () => {
      verified = true;
      return ["shape"];
    },
  );
  expect(verified).toBe(false);
  expect(result).toEqual({ stoppedBy: [], skipped: [] });
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

test("attachPreCheckStop never lets a stopped review approve, and says which agents did not run", () => {
  const approved: CoordinatorOutput = {
    decision: "approve",
    findings: [],
    summary: "s",
    incomplete: [],
  };
  const stopped = attachPreCheckStop(approved, { stoppedBy: ["shape"], skipped: ["deep"] });
  expect(stopped.decision).toBe("approve_with_comments");
  expect(stopped.incomplete).toEqual([
    "A pre-check (shape) found a blocking problem, so these reviewers did not run: deep.",
  ]);

  const blocked = attachPreCheckStop(
    { ...approved, decision: "request_changes" },
    { stoppedBy: ["shape"], skipped: ["deep"] },
  );
  expect(blocked.decision).toBe("request_changes");

  expect(attachPreCheckStop(approved, { stoppedBy: [], skipped: [] })).toEqual(approved);
});

test("loads preCheckAgents that name agents in the roster", async () => {
  await writeRootConfig({ preCheckAgents: ["shape"] });
  expect((await loadReviewConfig(root)).preCheckAgents).toEqual(["shape"]);
});

test("refuses a preCheckAgents id that is not an agent", async () => {
  await writeRootConfig({ preCheckAgents: ["shap"] });
  await expect(loadReviewConfig(root)).rejects.toThrow(/preCheckAgents.*"shap"/);
});
