import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyConfig } from "../commands/verify-config.js";
import { CONFIG_DIRNAME } from "../config/load.js";

const EXPECTED = "ANTHROPIC_OAUTH_API_KEY";

/** Write a file, creating parent dirs. */
async function put(root: string, relPath: string, content: string): Promise<void> {
  const full = path.join(root, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ecr-verify-"));
}

const problems = (findings: Array<{ problem: string }>): string =>
  findings.map((f) => f.problem).join(" | ");

test("passes on a clean root-only config with the expected tokenEnv", async () => {
  const root = await makeRoot();
  await put(
    root,
    `${CONFIG_DIRNAME}/config.jsonc`,
    `{
      // root config
      "model": "anthropic/claude-sonnet-5",
      "auth": { "mode": "oauth", "provider": "anthropic", "tokenEnv": "${EXPECTED}" },
    }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(true);
  expect(result.findings).toEqual([]);
});

test("refuses a scope config that declares auth", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "auth": { "tokenEnv": "${EXPECTED}" } }`);
  await put(
    root,
    `server/www/${CONFIG_DIRNAME}/config.jsonc`,
    `{ "model": "anthropic/claude-sonnet-5", "auth": { "mode": "api-key", "tokenEnv": "SNEAKY" } }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("non-root config declares auth");
});

test("refuses a scope config that declares breakGlass", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "auth": { "tokenEnv": "${EXPECTED}" } }`);
  await put(
    root,
    `server/www/${CONFIG_DIRNAME}/config.jsonc`,
    `{ "model": "anthropic/claude-sonnet-5", "breakGlass": { "marker": "override-me" } }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("non-root config declares breakGlass");
});

test("refuses a scope config that declares commentTag", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "auth": { "tokenEnv": "${EXPECTED}" } }`);
  await put(
    root,
    `server/www/${CONFIG_DIRNAME}/config.jsonc`,
    `{ "model": "anthropic/claude-sonnet-5", "commentTag": "impostor-tag" }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("non-root config declares commentTag");
});

test("refuses a duplicate tokenEnv across root config.jsonc and routing.jsonc", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "auth": { "tokenEnv": "${EXPECTED}" } }`);
  await put(
    root,
    `${CONFIG_DIRNAME}/routing.jsonc`,
    `{
      "defaults": { "auth": { "mode": "oauth", "tokenEnv": "${EXPECTED}" } },
      "scopes": [{ "name": "default", "paths": ["**/*"], "config": "." }]
    }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("declared in 2 root files");
});

test("refuses when the tokenEnv differs from the expected value", async () => {
  const root = await makeRoot();
  await put(
    root,
    `${CONFIG_DIRNAME}/config.jsonc`,
    `{ "auth": { "mode": "api-key", "tokenEnv": "SOME_OTHER_SECRET" } }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain(`!= expected [${EXPECTED}]`);
});

test("refuses (fail-closed) when a config fails to parse", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "auth": { "tokenEnv": "${EXPECTED}" } }`);
  await put(root, `bad/${CONFIG_DIRNAME}/config.jsonc`, `{ "model": "x" "oops" }`);
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("failed to parse");
});

test("refuses an UNREFERENCED nested config dir carrying auth (not trusting the manifest)", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "auth": { "tokenEnv": "${EXPECTED}" } }`);
  await put(
    root,
    `${CONFIG_DIRNAME}/routing.jsonc`,
    `{ "scopes": [{ "name": "default", "paths": ["**/*"], "config": "." }] }`,
  );
  // A staged dir no scope references — must still be swept.
  await put(
    root,
    `packages/rogue/${CONFIG_DIRNAME}/config.jsonc`,
    `{ "auth": { "mode": "api-key", "tokenEnv": "EVIL_SECRET" } }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("non-root config declares auth");
  expect(problems(result.findings)).toContain("EVIL_SECRET");
});

test("routing.jsonc defaults.auth counts as the single root tokenEnv occurrence", async () => {
  const root = await makeRoot();
  // Root config declares NO auth; the tokenEnv lives only in routing defaults.auth.
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "model": "anthropic/claude-sonnet-5" }`);
  await put(
    root,
    `${CONFIG_DIRNAME}/routing.jsonc`,
    `{
      "defaults": { "auth": { "mode": "oauth", "provider": "anthropic", "tokenEnv": "${EXPECTED}" } },
      "scopes": [{ "name": "default", "paths": ["**/*"], "config": "." }]
    }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(true);
  expect(result.findings).toEqual([]);
});

test("refuses a tokenEnv declared only in a non-root file", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "model": "anthropic/claude-sonnet-5" }`);
  await put(
    root,
    `server/www/${CONFIG_DIRNAME}/config.jsonc`,
    `{ "auth": { "tokenEnv": "${EXPECTED}" } }`,
  );
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("declared outside the root config");
});

test("passes with no expectation set and no tokenEnv anywhere", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "model": "anthropic/claude-sonnet-5" }`);
  const result = await verifyConfig(root, {});
  expect(result.ok).toBe(true);
});

test("refuses zero tokenEnv occurrences when an expectation is set", async () => {
  const root = await makeRoot();
  await put(root, `${CONFIG_DIRNAME}/config.jsonc`, `{ "model": "anthropic/claude-sonnet-5" }`);
  const result = await verifyConfig(root, { expected: EXPECTED });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("no tokenEnv found");
});

// ---- multi-provider auth (auth.providers map) ----

test("a providers map with several tokenEnvs in ONE root file passes against the expected set", async () => {
  const root = await makeRoot();
  await put(
    root,
    `${CONFIG_DIRNAME}/config.jsonc`,
    `{
      "auth": { "providers": {
        "openai":     { "mode": "oauth",   "tokenEnv": "CODEX_OAUTH_REFRESH_TOKEN" },
        "openai-api": { "mode": "api-key", "tokenEnv": "OPENAI_API_KEY", "upstream": "openai" }
      } }
    }`,
  );
  // Order-insensitive: the workflow may list the set in either order.
  const result = await verifyConfig(root, {
    expected: "OPENAI_API_KEY,CODEX_OAUTH_REFRESH_TOKEN",
  });
  expect(result.ok).toBe(true);
});

test("a providers map naming a credential OUTSIDE the expected set is refused", async () => {
  const root = await makeRoot();
  await put(
    root,
    `${CONFIG_DIRNAME}/config.jsonc`,
    `{
      "auth": { "providers": {
        "openai":     { "mode": "oauth",   "tokenEnv": "CODEX_OAUTH_REFRESH_TOKEN" },
        "openai-api": { "mode": "api-key", "tokenEnv": "SOME_OTHER_SECRET", "upstream": "openai" }
      } }
    }`,
  );
  // A PR must not be able to ADD a forwarded credential any more than repoint one.
  const result = await verifyConfig(root, { expected: "CODEX_OAUTH_REFRESH_TOKEN" });
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("SOME_OTHER_SECRET");
});

test("two providers entries forwarding the SAME env var are refused", async () => {
  const root = await makeRoot();
  await put(
    root,
    `${CONFIG_DIRNAME}/config.jsonc`,
    `{
      "auth": { "providers": {
        "openai":     { "mode": "oauth",   "tokenEnv": "SHARED" },
        "openai-api": { "mode": "api-key", "tokenEnv": "SHARED", "upstream": "openai" }
      } }
    }`,
  );
  const result = await verifyConfig(root);
  expect(result.ok).toBe(false);
  expect(problems(result.findings)).toContain("more than once");
});
