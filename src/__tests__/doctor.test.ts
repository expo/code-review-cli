import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveEngines } from "../commands/doctor.js";
import { loadReviewConfig, CONFIG_DIRNAME } from "../config/load.js";
import { RoutingManifestSchema } from "../config/schema.js";
import type { RoutingManifest } from "../config/schema.js";
import { loadRoutingManifest } from "../config/routing.js";

/** Write a config dir (config.jsonc + coordinator + one agent per id). */
async function writeConfigDir(
  dir: string,
  opts: { config: string; agents: Record<string, string>; coordinator?: string },
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), opts.config, "utf8");
  await writeFile(path.join(dir, "coordinator.md"), opts.coordinator ?? "Coordinator.", "utf8");
  for (const [id, body] of Object.entries(opts.agents)) {
    await writeFile(path.join(dir, "agents", `${id}.md`), body, "utf8");
  }
}

const agent = (name: string): string => `---\ndescription: ${name}\n---\n${name.toUpperCase()}`;
const manifestOf = (m: unknown): RoutingManifest => RoutingManifestSchema.parse(m);

/** An OpenCode-only root repo (default model openai/gpt-5.5), returning its path. */
async function makeOpencodeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-doctor-"));
  await writeConfigDir(path.join(root, CONFIG_DIRNAME), {
    config: "{}", // model defaults to openai/gpt-5.5 → opencode engine
    agents: { correctness: agent("correctness"), security: agent("security") },
  });
  return root;
}

test("resolveEngines: root-only config reports only the engines its models use", async () => {
  const root = await makeOpencodeRoot();
  const rootConfig = await loadReviewConfig(root);
  const engines = await resolveEngines(root, rootConfig, null);
  expect(engines.has("opencode")).toBe(true);
  expect(engines.has("claude-code")).toBe(false);
});

test("resolveEngines: a scope selecting an anthropic model adds the Claude Code engine", async () => {
  const root = await makeOpencodeRoot();
  // A nested scope pins an anthropic/… model — the scoped review needs the Claude
  // CLI/login even though the OpenCode-only root config never touches it.
  await writeConfigDir(path.join(root, "server", "www", CONFIG_DIRNAME), {
    config: '{ "model": "anthropic/claude-opus-5" }',
    agents: { style: agent("style") },
  });
  await writeFile(
    path.join(root, CONFIG_DIRNAME, "routing.jsonc"),
    `{ "scopes": [
       { "name": "default", "paths": ["**/*"], "config": "." },
       { "name": "www", "paths": ["server/www/**"], "config": "server/www" }
     ] }`,
    "utf8",
  );
  const rootConfig = await loadReviewConfig(root);
  const manifest = await loadRoutingManifest(root);
  const engines = await resolveEngines(root, rootConfig, manifest);
  // Without folding scopes in, this would be opencode-only and doctor would skip the
  // Claude CLI/login checks the www scope's review actually needs.
  expect(engines.has("claude-code")).toBe(true);
  expect(engines.has("opencode")).toBe(true);
});

test("resolveEngines: a malformed scope config is skipped, not fatal", async () => {
  const root = await makeOpencodeRoot();
  // A scope declaring auth is rejected by the scope schema (loadScopeConfig throws);
  // resolveEngines must swallow it (the scope-validation block reports it) and still
  // return the root engines.
  await writeConfigDir(path.join(root, "bad", CONFIG_DIRNAME), {
    config: '{ "auth": { "mode": "oauth", "tokenEnv": "SNEAKY" } }',
    agents: { style: agent("style") },
  });
  const manifest = manifestOf({ scopes: [{ name: "bad", paths: ["bad/**"], config: "bad" }] });
  const rootConfig = await loadReviewConfig(root);
  const engines = await resolveEngines(root, rootConfig, manifest);
  expect(engines.has("opencode")).toBe(true);
  expect(engines.has("claude-code")).toBe(false);
});
