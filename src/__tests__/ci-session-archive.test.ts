import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runLegacyCi, runRoutedCi } from "../commands/ci.js";
import type { CiRunOptions } from "../commands/ci.js";
import { CONFIG_DIRNAME } from "../config/load.js";
import { loadRoutingManifest } from "../config/routing.js";
import { resetTrustedToolCache } from "../core/exec.js";
import { createSessionCapture, parseSessionIndex, unzipEntries } from "../core/session-archive.js";
import type { SessionCapture } from "../core/session-archive.js";
import type { ReviewSource } from "../sources/source.js";

const HEAD = "a".repeat(40);

// A stand-in `gh` that logs each call. It answers the store check, and every write.
// It keeps a copy of the archive that an upload sends.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
case "$*" in
  "repo view "*) printf '{"visibility":"PRIVATE"}' ;;
  "release create "*) cp "$4" "$FAKE_GH_DIR/uploaded.zip" ;;
  "api user"*) printf 'ecr-bot\\n' ;;
  *"-X POST "*|*"-X PATCH "*) printf '{"id": 1}' ;;
  *) printf '[]' ;;
esac
`;

const ENV_NAMES = [
  "PATH",
  "FAKE_GH_DIR",
  "SESSION_STORE_REPO",
  "ECR_EXPECTED_TOKEN_ENV",
  "GITHUB_ACTIONS",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_RUN_ID",
];

let root = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ecr-ci-session-"));
  const bin = path.join(root, "bin");
  const config = path.join(root, "repo", CONFIG_DIRNAME);
  await mkdir(bin);
  await mkdir(path.join(config, "agents"), { recursive: true });
  await writeFile(path.join(bin, "gh"), FAKE_GH, "utf8");
  await chmod(path.join(bin, "gh"), 0o755);
  await writeFile(path.join(root, "calls.log"), "", "utf8");
  await writeFile(path.join(config, "config.jsonc"), "{}", "utf8");
  await writeFile(path.join(config, "coordinator.md"), "Coordinate.", "utf8");
  // No changed file matches, so the review ends before it starts a model.
  await writeFile(
    path.join(config, "agents", "docs.md"),
    '---\npaths: ["docs/**"]\n---\nDocs',
    "utf8",
  );
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = root;
  process.env.SESSION_STORE_REPO = "expo/store";
  resetTrustedToolCache();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetTrustedToolCache();
  await rm(root, { recursive: true, force: true });
});

/** Record one pass, as if a reviewer had run. */
function notePass(capture: SessionCapture, sessionId: string): void {
  capture.note({
    agent: "correctness",
    title: "review-correctness-c0",
    source: "claude",
    sessionId,
    exportJson: "{}",
  });
}

const changed = (...paths: string[]) =>
  paths.map((file) => ({ path: file, patch: "@@ -1 +1 @@\n-a\n+b", status: "M" as const }));

const options = (sessionCapture: SessionCapture): CiRunOptions => ({
  agents: undefined,
  route: false,
  bypassTriggerGate: true,
  configDir: undefined,
  contextText: undefined,
  noStackAware: true,
  sessionCapture,
});

const ghCalls = async (): Promise<string[]> =>
  (await readFile(path.join(root, "calls.log"), "utf8")).split("\n").filter(Boolean);

const COMMENT_POSTED = /-X POST .*\/issues\/7\/comments/;

function sourceWith(getChangedFiles: ReviewSource["getChangedFiles"]): ReviewSource {
  return {
    getMetadata: async () => ({
      title: "t",
      body: "b",
      baseRef: "main",
      headRef: "feature",
      headOid: HEAD,
    }),
    getChangedFiles,
  };
}

async function runCi(source: ReviewSource): Promise<string[]> {
  const repo = path.join(root, "repo");
  const capture = createSessionCapture();
  notePass(capture, "ses_recorded");
  await runLegacyCi(source, "expo/expo", 7, repo, repo, options(capture));
  return ghCalls();
}

/**
 * Run the routed path over a `web` scope and an `api` scope.
 * Each scope has one recorded pass.
 */
async function runRouted(): Promise<string[]> {
  const repo = path.join(root, "repo");
  await writeFile(
    path.join(repo, CONFIG_DIRNAME, "routing.jsonc"),
    JSON.stringify({
      defaults: { enforceAgents: [] },
      comment: "single",
      scopes: [
        { name: "web", paths: ["web/**"], config: "web" },
        { name: "api", paths: ["api/**"], config: "api" },
      ],
    }),
  );
  const manifest = await loadRoutingManifest(repo);
  const capture = createSessionCapture();
  notePass(capture.withScope("web"), "ses_web");
  notePass(capture.withScope("api"), "ses_api");
  const source = {
    ...sourceWith(async () => changed("web/a.ts", "api/b.ts")),
    dispose: async () => {},
  };
  await runRoutedCi(source, manifest!, "expo/expo", 7, repo, repo, options(capture));
  return ghCalls();
}

/** The scope of each pass in the archive that the upload sent. */
async function uploadedScopes(): Promise<(string | undefined)[]> {
  const entries = unzipEntries(await readFile(path.join(root, "uploaded.zip")));
  const index = parseSessionIndex(entries.get("index.json")!().toString("utf8"));
  return index.passes.map((pass) => pass.scope);
}

describe("Storing sessions from ecr ci", () => {
  test("should upload after the review comment is posted", async () => {
    const calls = await runCi(sourceWith(async () => changed("src/a.ts")));
    const posted = calls.findIndex((call) => COMMENT_POSTED.test(call));
    const viewed = calls.findIndex((call) => call.startsWith("repo view expo/store"));
    const created = calls.findIndex((call) =>
      call.startsWith("release create session/expo/expo/7/"),
    );
    expect(posted).toBeGreaterThanOrEqual(0);
    expect(viewed).toBeGreaterThan(posted);
    expect(created).toBeGreaterThan(viewed);
  }, 30_000);

  test("should upload nothing when the review throws", async () => {
    const calls = await runCi(
      sourceWith(async () => {
        throw new Error("the diff could not be read");
      }),
    );
    // The failure note is posted, and the recorded pass is not stored.
    expect(calls.some((call) => COMMENT_POSTED.test(call))).toBe(true);
    expect(calls.filter((call) => /^(repo view|release create)/.test(call))).toEqual([]);
  }, 30_000);

  test("should upload one archive for every scope after the routed comment is posted", async () => {
    const calls = await runRouted();
    const posted = calls.findIndex((call) => COMMENT_POSTED.test(call));
    const created = calls.findIndex((call) =>
      call.startsWith("release create session/expo/expo/7/"),
    );
    expect(posted).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(posted);
    expect(calls.filter((call) => call.startsWith("release create"))).toHaveLength(1);
    expect(await uploadedScopes()).toEqual(["web", "api"]);
  }, 30_000);

  test("should leave out the passes of a routed scope that failed", async () => {
    // A scope config that cannot be read makes the review of that scope throw.
    const broken = path.join(root, "repo", "api", CONFIG_DIRNAME);
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "config.jsonc"), "{ not json", "utf8");
    const calls = await runRouted();
    expect(calls.some((call) => COMMENT_POSTED.test(call))).toBe(true);
    expect(await uploadedScopes()).toEqual(["web"]);
  }, 30_000);
});
