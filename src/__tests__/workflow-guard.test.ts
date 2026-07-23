import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Fixture tests for the CI guard script in templates/workflow.yml: extract the
 * guard step's `run: |` body verbatim and execute it against scaffolds shaped
 * like `ecr init --monorepo` + `ecr init --scope <dir>` output, so guard/template
 * drift (e.g. a commented-out example tripping the sweep) is caught before merge.
 */

const TEMPLATES_DIR = path.join(import.meta.dir, "..", "..", "templates");
const EXPECTED = "ANTHROPIC_OAUTH_API_KEY";

async function guardScript(): Promise<string> {
  const yml = await readFile(path.join(TEMPLATES_DIR, "workflow.yml"), "utf8");
  const lines = yml.split("\n");
  const step = lines.findIndex((line) => line.includes("Guard config tokenEnv"));
  expect(step).toBeGreaterThan(-1);
  const runIdx = lines.findIndex((line, i) => i > step && line.trim() === "run: |");
  expect(runIdx).toBeGreaterThan(-1);
  const indent = /^(\s*)/.exec(lines[runIdx]!)![1]!.length + 2;
  const body: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!line.startsWith(" ".repeat(indent))) {
      break;
    }
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** Scaffold the README onboarding path: init --monorepo + two scope inits. */
async function scaffoldMonorepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-guard-"));
  await mkdir(path.join(root, ".expo-code-review"), { recursive: true });
  await copyFile(
    path.join(TEMPLATES_DIR, "config.jsonc"),
    path.join(root, ".expo-code-review", "config.jsonc"),
  );
  await copyFile(
    path.join(TEMPLATES_DIR, "routing.jsonc"),
    path.join(root, ".expo-code-review", "routing.jsonc"),
  );
  for (const dir of ["server/www", "server/website"]) {
    await mkdir(path.join(root, dir, ".expo-code-review"), { recursive: true });
    await copyFile(
      path.join(TEMPLATES_DIR, "scope-config.jsonc"),
      path.join(root, dir, ".expo-code-review", "config.jsonc"),
    );
  }
  return root;
}

async function runGuard(cwd: string): Promise<{ status: number | null; output: string }> {
  const script = await guardScript();
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    env: { ...process.env, EXPECTED },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test("guard: the default monorepo scaffold (init --monorepo + 2x init --scope) passes", async () => {
  const root = await scaffoldMonorepo();
  const { status, output } = await runGuard(root);
  expect(output).not.toContain("::error::");
  expect(status).toBe(0);
});

test("guard: commented-out tokenEnv examples do not count as occurrences", async () => {
  const root = await scaffoldMonorepo();
  const routingPath = path.join(root, ".expo-code-review", "routing.jsonc");
  const routing = await readFile(routingPath, "utf8");
  await writeFile(
    routingPath,
    routing.replace('"defaults": {', '"defaults": {\n    // "tokenEnv": "ANTHROPIC_OAUTH_API_KEY"'),
  );
  const { status } = await runGuard(root);
  expect(status).toBe(0);
});

test("guard: duplicate real commentTag across scope configs fails", async () => {
  const root = await scaffoldMonorepo();
  for (const dir of ["server/www", "server/website"]) {
    await writeFile(
      path.join(root, dir, ".expo-code-review", "config.jsonc"),
      '{\n  "model": "anthropic/claude-sonnet-5",\n  "commentTag": "team-tag"\n}\n',
    );
  }
  const { status, output } = await runGuard(root);
  expect(status).toBe(1);
  expect(output).toContain("duplicate commentTag");
});

test("guard: a tokenEnv split across lines in routing.jsonc defaults.auth is caught", async () => {
  const root = await scaffoldMonorepo();
  await writeFile(
    path.join(root, ".expo-code-review", "routing.jsonc"),
    [
      "{",
      '  "defaults": {',
      '    "auth": { "mode": "api-key", "provider": "openrouter", "tokenEnv"',
      ":",
      '"SOME_OTHER_SECRET" },',
      '    "commentTag": "expo-ai-code-reviewer"',
      "  },",
      '  "scopes": [{ "name": "default", "paths": ["**/*"], "config": "." }]',
      "}",
      "",
    ].join("\n"),
  );
  const { status, output } = await runGuard(root);
  expect(status).toBe(1);
  expect(output).toContain("tokenEnv must appear exactly once");
});

test('guard: a quote trick ("x": "//") cannot hide a tokenEnv the loader would honor', async () => {
  const root = await scaffoldMonorepo();
  await writeFile(
    path.join(root, ".expo-code-review", "routing.jsonc"),
    [
      "{",
      '  "defaults": {',
      '    "auth": { "mode": "api-key", "provider": "openrouter", "x": "//", "tokenEnv": "EVIL_SECRET" },',
      '    "commentTag": "expo-ai-code-reviewer"',
      "  },",
      '  "scopes": [{ "name": "default", "paths": ["**/*"], "config": "." }]',
      "}",
      "",
    ].join("\n"),
  );
  const { status, output } = await runGuard(root);
  expect(status).toBe(1);
  expect(output).toContain("tokenEnv must appear exactly once");
});

test("guard: a scope config staging a tokenEnv fails (count > 1)", async () => {
  const root = await scaffoldMonorepo();
  await writeFile(
    path.join(root, "server/www", ".expo-code-review", "config.jsonc"),
    `{\n  "auth": { "mode": "api-key", "provider": "openrouter", "tokenEnv": "${EXPECTED}" }\n}\n`,
  );
  const { status, output } = await runGuard(root);
  expect(status).toBe(1);
  expect(output).toContain("tokenEnv must appear exactly once");
});
