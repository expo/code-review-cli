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
import { loadRoutingManifest } from "../config/routing.js";
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
  expect(scoped.auth[0]?.tokenEnv).toBe("MANIFEST_TOKEN"); // from loadAuthFromRoot
});

test("loadScopeConfig: nested scope reads its own roster/prompts; auth forced from root", async () => {
  const root = await makeRoot('{ "auth": { "mode": "oauth", "tokenEnv": "ROOT_TOKEN" } }');
  await writeConfigDir(path.join(root, "server", "www", CONFIG_DIRNAME), {
    // No auth here; scope-specific model + noise override the root.
    config:
      '{ "model": "anthropic/claude-opus-5", "noise": { "additionalIgnores": ["www/gen/**"] } }',
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
  expect(scoped.agents.find((a) => a.id === "style")!.model).toBe("anthropic/claude-opus-5");
  // auth is forced from the root even though the scope config declares none.
  expect(scoped.auth[0]?.tokenEnv).toBe("ROOT_TOKEN");
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
  expect(loadAuthFromRoot(rootConfig, manifest)[0]?.tokenEnv).toBe("MANIFEST");
  expect(loadAuthFromRoot(rootConfig, null)[0]?.tokenEnv).toBe("ROOT");
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
  expect(auth[0]?.mode).toBe("oauth");
  expect(auth[0]?.tokenEnv).toBe("ANTHROPIC_OAUTH_API_KEY");
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

test("config-dir override composes: root config + routing.jsonc from override, scopes from repo root", async () => {
  const root = await makeRoot('{ "commentTag": "real-root" }');
  // The alternate ROOT config dir holds its own config.jsonc AND routing.jsonc.
  await writeConfigDir(path.join(root, "altroot"), {
    config: '{ "commentTag": "alt-root-tag" }',
    agents: { correctness: agent("correctness"), security: agent("security") },
  });
  await writeFile(
    path.join(root, "altroot", "routing.jsonc"),
    `{ "scopes": [
       { "name": "default", "paths": ["**/*"], "config": "." },
       { "name": "www", "paths": ["server/www/**"], "config": "server/www" }
     ] }`,
    "utf8",
  );
  // The scope subtree lives at the REPO ROOT, not under the override dir.
  await writeConfigDir(path.join(root, "server", "www", CONFIG_DIRNAME), {
    config: '{ "model": "anthropic/claude-opus-5" }',
    agents: { style: agent("style") },
  });

  // routing.jsonc is read from the override dir (the default tree's is absent).
  const manifest = await loadRoutingManifest(root, { configDir: "altroot" });
  expect(manifest).not.toBeNull();
  expect(manifest!.scopes.map((s) => s.name)).toEqual(["default", "www"]);

  // The root config artifacts follow the override.
  const rootConfig = await loadReviewConfig(root, { configDir: "altroot" });
  expect(rootConfig.commentTag).toBe("alt-root-tag");

  // The default scope reuses the override's root config.
  const def = await loadScopeConfig(root, manifest!.scopes[0]!, manifest!, rootConfig);
  expect(def.commentTag).toBe("alt-root-tag");

  // The nested scope is still resolved from the repo root (server/www), NOT the
  // override dir — the override must not relocate the scopes themselves.
  const www = await loadScopeConfig(root, manifest!.scopes[1]!, manifest!, rootConfig);
  expect(www.agents.some((a) => a.id === "style")).toBe(true);
  expect(www.agents.find((a) => a.id === "style")!.model).toBe("anthropic/claude-opus-5");
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

// ---- REVIEWER_MODEL override ----
//
// Regression: GitHub Actions passes `${{ vars.REVIEWER_MODEL }}` as an EMPTY STRING when
// that repo variable doesn't exist, which both scaffolded workflows do. `??` only falls
// through on null/undefined, so every configured model silently became "" and each agent
// ran on whatever OpenCode picked by default — a config saying anthropic/claude-sonnet-5
// reviewed with something else entirely, and nothing reported it.

async function modelsWithOverride(value: string | undefined): Promise<string[]> {
  const prev = process.env.REVIEWER_MODEL;
  if (value === undefined) {
    delete process.env.REVIEWER_MODEL;
  } else {
    process.env.REVIEWER_MODEL = value;
  }
  try {
    const root = await makeRoot(JSON.stringify({ model: "anthropic/claude-sonnet-5" }));
    const config = await loadReviewConfig(root);
    return [...config.agents.map((a) => a.model), config.coordinator.model];
  } finally {
    if (prev === undefined) {
      delete process.env.REVIEWER_MODEL;
    } else {
      process.env.REVIEWER_MODEL = prev;
    }
  }
}

test("an EMPTY REVIEWER_MODEL is ignored, not treated as a model id", async () => {
  for (const model of await modelsWithOverride("")) {
    expect(model).toBe("anthropic/claude-sonnet-5");
  }
});

test("a whitespace-only REVIEWER_MODEL is ignored too", async () => {
  for (const model of await modelsWithOverride("   ")) {
    expect(model).toBe("anthropic/claude-sonnet-5");
  }
});

test("an unset REVIEWER_MODEL uses the configured model", async () => {
  for (const model of await modelsWithOverride(undefined)) {
    expect(model).toBe("anthropic/claude-sonnet-5");
  }
});

test("a real REVIEWER_MODEL still overrides every agent and the coordinator", async () => {
  for (const model of await modelsWithOverride("openai/gpt-5.5")) {
    expect(model).toBe("openai/gpt-5.5");
  }
});

test("a REVIEWER_MODEL with stray whitespace is trimmed, not passed through", async () => {
  for (const model of await modelsWithOverride(" openai/gpt-5.5\n")) {
    expect(model).toBe("openai/gpt-5.5");
  }
});

test("auth.providers map normalizes into one entry per provider (upstream preserved)", async () => {
  const root = await makeRoot(
    `{ "auth": { "providers": {
        "openai":     { "mode": "oauth",   "tokenEnv": "CODEX_OAUTH_REFRESH_TOKEN" },
        "openai-api": { "mode": "api-key", "tokenEnv": "OPENAI_API_KEY", "upstream": "openai" }
    } } }`,
  );
  const config = await loadReviewConfig(root);
  expect(config.auth).toEqual([
    {
      provider: "openai",
      mode: "oauth",
      tokenEnv: "CODEX_OAUTH_REFRESH_TOKEN",
      upstream: undefined,
    },
    { provider: "openai-api", mode: "api-key", tokenEnv: "OPENAI_API_KEY", upstream: "openai" },
  ]);
});

test("legacy single-object auth still parses (one normalized entry)", async () => {
  const root = await makeRoot('{ "auth": { "mode": "api-key", "tokenEnv": "OPENAI_API_KEY" } }');
  const config = await loadReviewConfig(root);
  expect(config.auth).toEqual([
    { provider: "openai", mode: "api-key", tokenEnv: "OPENAI_API_KEY" },
  ]);
});

test("anthropic auth entries pass through both shapes (mode defaults to api-key, irrelevant to the engine)", async () => {
  const mapRoot = await makeRoot(
    `{ "auth": { "providers": {
        "anthropic": { "tokenEnv": "CLAUDE_CODE_OAUTH_TOKEN" }
    } } }`,
  );
  expect((await loadReviewConfig(mapRoot)).auth).toEqual([
    {
      provider: "anthropic",
      mode: "api-key",
      tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      upstream: undefined,
    },
  ]);
  const legacyRoot = await makeRoot('{ "auth": { "provider": "anthropic" } }');
  expect((await loadReviewConfig(legacyRoot)).auth).toEqual([
    { provider: "anthropic", mode: "api-key", tokenEnv: undefined },
  ]);
});
