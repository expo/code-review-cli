import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ScopeReviewConfigSchema, RoutingManifestSchema } from "../config/schema.js";
import {
  loadReviewConfig,
  loadScopeConfig,
  loadAuthFromRoot,
  CONFIG_DIRNAME,
} from "../config/load.js";
import type { RoutingManifest } from "../config/schema.js";

async function writeConfigDir(
  dir: string,
  opts: { config: string; agents: Record<string, string>; coordinator?: string; shared?: string },
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), opts.config, "utf8");
  await writeFile(
    path.join(dir, "coordinator.md"),
    opts.coordinator ?? "Coordinator prompt.",
    "utf8",
  );
  if (opts.shared !== undefined) {
    await writeFile(path.join(dir, "shared.md"), opts.shared, "utf8");
  }
  for (const [id, body] of Object.entries(opts.agents)) {
    await writeFile(path.join(dir, "agents", `${id}.md`), body, "utf8");
  }
}

const agent = (name: string, extra = ""): string =>
  `---\ndescription: ${name} agent\n${extra}---\n${name.toUpperCase()} PROMPT`;

/** A repo root with a full root config dir, returning its path. */
async function makeRoot(rootConfig = "{}"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-scope-"));
  await writeConfigDir(path.join(root, CONFIG_DIRNAME), {
    config: rootConfig,
    agents: {
      correctness: agent("correctness"),
      security: agent("security"),
    },
  });
  return root;
}

const manifestOf = (m: unknown): RoutingManifest => RoutingManifestSchema.parse(m);

// ---- ScopeReviewConfigSchema ----

test("ScopeReviewConfigSchema: rejects auth (any value)", () => {
  expect(ScopeReviewConfigSchema.safeParse({ auth: { mode: "oauth" } }).success).toBe(false);
  expect(ScopeReviewConfigSchema.safeParse({ auth: {} }).success).toBe(false);
});

test("ScopeReviewConfigSchema: rejects breakGlass", () => {
  expect(ScopeReviewConfigSchema.safeParse({ breakGlass: { marker: "/x" } }).success).toBe(false);
});

test("ScopeReviewConfigSchema: accepts model/policy/chunk/noise", () => {
  const parsed = ScopeReviewConfigSchema.parse({
    model: "anthropic/claude-sonnet-5",
    policy: { includeSuggestions: true },
    chunk: { maxChangedLines: 500, maxFiles: 10, concurrency: 3 },
    noise: { additionalIgnores: ["x/**"] },
  });
  expect(parsed.policy.includeSuggestions).toBe(true);
});

test("ScopeReviewConfigSchema: rejects commentTag (per-scope markers are derived)", () => {
  expect(ScopeReviewConfigSchema.safeParse({ commentTag: "scope-tag" }).success).toBe(false);
});

// ---- loadScopeConfig ----

test("loadScopeConfig: config '.' reuses the root config, auth from loadAuthFromRoot", async () => {
  const root = await makeRoot('{ "commentTag": "root-tag" }');
  const manifest = manifestOf({
    defaults: { auth: { mode: "oauth", provider: "anthropic", tokenEnv: "MANIFEST_TOKEN" } },
    scopes: [{ name: "default", paths: ["**/*"], config: "." }],
  });
  const rootConfig = await loadReviewConfig(root);
  const scoped = await loadScopeConfig(root, manifest.scopes[0]!, manifest, rootConfig);
  expect(scoped.scopeName).toBe("default");
  expect(scoped.commentTag).toBe("root-tag"); // keeps the ROOT marker (risk 8)
  expect(scoped.agents.map((a) => a.id).sort()).toEqual(["correctness", "security"]);
  expect(scoped.auth.tokenEnv).toBe("MANIFEST_TOKEN"); // from loadAuthFromRoot
});

test("loadScopeConfig: nested scope reads its own roster/prompts; auth forced from root", async () => {
  const root = await makeRoot('{ "auth": { "mode": "oauth", "tokenEnv": "ROOT_TOKEN" } }');
  await writeConfigDir(path.join(root, "server", "www", CONFIG_DIRNAME), {
    // No auth here; scope-specific model + noise override the root.
    config:
      '{ "model": "anthropic/claude-opus-4-1", "noise": { "additionalIgnores": ["www/gen/**"] } }',
    agents: { style: agent("style") },
  });
  const manifest = manifestOf({
    scopes: [
      { name: "default", paths: ["**/*"], config: "." },
      { name: "www", paths: ["server/www/**"], config: "server/www" },
    ],
  });
  const rootConfig = await loadReviewConfig(root);
  const scoped = await loadScopeConfig(root, manifest.scopes[1]!, manifest, rootConfig);
  expect(scoped.agents.some((a) => a.id === "style")).toBe(true);
  expect(scoped.noise.additionalIgnores).toEqual(["www/gen/**"]);
  expect(scoped.agents.find((a) => a.id === "style")!.model).toBe("anthropic/claude-opus-4-1");
  // auth is forced from the root even though the scope config declares none.
  expect(scoped.auth.tokenEnv).toBe("ROOT_TOKEN");
});

test("loadScopeConfig: a scope declaring auth fails to load (Zod-level rejection)", async () => {
  const root = await makeRoot();
  await writeConfigDir(path.join(root, "bad", CONFIG_DIRNAME), {
    config: '{ "auth": { "mode": "oauth", "tokenEnv": "SNEAKY" } }',
    agents: { style: agent("style") },
  });
  const manifest = manifestOf({ scopes: [{ name: "bad", paths: ["bad/**"], config: "bad" }] });
  const rootConfig = await loadReviewConfig(root);
  await expect(loadScopeConfig(root, manifest.scopes[0]!, manifest, rootConfig)).rejects.toThrow(
    /auth/,
  );
});

test("loadAuthFromRoot: defaults.auth (manifest) beats root config auth", async () => {
  const root = await makeRoot('{ "auth": { "mode": "api-key", "tokenEnv": "ROOT" } }');
  const rootConfig = await loadReviewConfig(root);
  const manifest = manifestOf({
    defaults: { auth: { mode: "oauth", provider: "anthropic", tokenEnv: "MANIFEST" } },
    scopes: [{ name: "default", paths: ["**/*"], config: "." }],
  });
  expect(loadAuthFromRoot(rootConfig, manifest).tokenEnv).toBe("MANIFEST");
  expect(loadAuthFromRoot(rootConfig, null).tokenEnv).toBe("ROOT");
});

test("loadAuthFromRoot: manifest with defaults but no auth key keeps the root auth (no phantom stub)", async () => {
  const root = await makeRoot(
    '{ "auth": { "mode": "oauth", "tokenEnv": "ANTHROPIC_OAUTH_API_KEY" } }',
  );
  const rootConfig = await loadReviewConfig(root);
  const manifest = manifestOf({
    // defaults present (as in every realistic manifest) but no auth key.
    defaults: { enforceAgents: ["security"], commentTag: "expo-ai-code-reviewer" },
    scopes: [{ name: "default", paths: ["**/*"], config: "." }],
  });
  // A `.default().optional()` chain in zod v4 would fire the inner default and
  // hand back a phantom {mode:'api-key',provider:'anthropic'} with no tokenEnv,
  // silently dropping the root's real oauth credential. It must stay undefined.
  expect(manifest.defaults.auth).toBeUndefined();
  const auth = loadAuthFromRoot(rootConfig, manifest);
  expect(auth.mode).toBe("oauth");
  expect(auth.tokenEnv).toBe("ANTHROPIC_OAUTH_API_KEY");
});

test("loadScopeConfig: enforceAgents injects the ROOT agent with alwaysRun", async () => {
  const root = await makeRoot();
  await writeConfigDir(path.join(root, "www", CONFIG_DIRNAME), {
    config: "{}",
    agents: { style: agent("style") }, // no security
  });
  const manifest = manifestOf({
    defaults: { enforceAgents: ["security"] },
    scopes: [{ name: "www", paths: ["www/**"], config: "www" }],
  });
  const rootConfig = await loadReviewConfig(root);
  const scoped = await loadScopeConfig(root, manifest.scopes[0]!, manifest, rootConfig);
  const security = scoped.agents.find((a) => a.id === "security");
  expect(security).toBeDefined();
  expect(security!.alwaysRun).toBe(true);
  expect(security!.promptText).toContain("SECURITY PROMPT"); // the ROOT prompt
});

test("loadScopeConfig: a scope shadowing the enforced id gets the ROOT version (risk 11)", async () => {
  const root = await makeRoot();
  await writeConfigDir(path.join(root, "www", CONFIG_DIRNAME), {
    config: "{}",
    // The scope defines its OWN weaker security agent — must be overridden.
    agents: { security: agent("weak-security", ""), style: agent("style") },
  });
  const manifest = manifestOf({
    defaults: { enforceAgents: ["security"] },
    scopes: [{ name: "www", paths: ["www/**"], config: "www" }],
  });
  const rootConfig = await loadReviewConfig(root);
  const scoped = await loadScopeConfig(root, manifest.scopes[0]!, manifest, rootConfig);
  const security = scoped.agents.find((a) => a.id === "security")!;
  expect(security.alwaysRun).toBe(true);
  expect(security.promptText).toContain("SECURITY PROMPT"); // ROOT wins
  expect(security.promptText).not.toContain("WEAK-SECURITY");
  // No duplicate security agent.
  expect(scoped.agents.filter((a) => a.id === "security").length).toBe(1);
});

test("loadScopeConfig: throws when an enforced id is missing from the root roster", async () => {
  const root = await makeRoot();
  const manifest = manifestOf({
    defaults: { enforceAgents: ["nonexistent"] },
    scopes: [{ name: "default", paths: ["**/*"], config: "." }],
  });
  const rootConfig = await loadReviewConfig(root);
  await expect(loadScopeConfig(root, manifest.scopes[0]!, manifest, rootConfig)).rejects.toThrow(
    /nonexistent/,
  );
});

// ---- config-dir escape hatch (graft 1) ----

test("loadReviewConfig: options.configDir loads from an alternate dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-cfgdir-"));
  await writeConfigDir(path.join(root, "custom"), {
    config: '{ "commentTag": "custom-marker" }',
    agents: { style: agent("style") },
  });
  const config = await loadReviewConfig(root, { configDir: "custom" });
  expect(config.commentTag).toBe("custom-marker");
});

test("loadReviewConfig: ECR_CONFIG_DIR loads from the alternate dir; unset → .expo-code-review (BACKCOMPAT)", async () => {
  const root = await makeRoot('{ "commentTag": "default-marker" }');
  await writeConfigDir(path.join(root, "alt"), {
    config: '{ "commentTag": "env-marker" }',
    agents: { style: agent("style") },
  });
  const previous = process.env.ECR_CONFIG_DIR;
  try {
    process.env.ECR_CONFIG_DIR = path.join(root, "alt");
    expect((await loadReviewConfig(root)).commentTag).toBe("env-marker");
  } finally {
    if (previous === undefined) delete process.env.ECR_CONFIG_DIR;
    else process.env.ECR_CONFIG_DIR = previous;
  }
  // Without the env var, the default dir is used.
  expect((await loadReviewConfig(root)).commentTag).toBe("default-marker");
});
