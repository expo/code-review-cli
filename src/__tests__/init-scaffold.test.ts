import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initCommand, parseTokenEnvs, substituteTokenEnv } from "../commands/init.js";
import { checkConfigRefs } from "../core/config-refs.js";
import { git } from "../core/exec.js";
import { CONFIG_DIRNAME } from "../config/load.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const cwds: string[] = [];
const originalCwd = process.cwd();
afterEach(async () => {
  process.chdir(originalCwd);
  for (const dir of cwds.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// `scaffold` resolves the repo root via `git rev-parse` in the process cwd, so a
// git-initialized temp dir makes the scaffold write into an isolated tree.
async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-init-"));
  cwds.push(dir);
  await git(["init", "-q"], dir);
  process.chdir(dir);
  return dir;
}

test("init scaffolds all three workflow files + routing templates", async () => {
  const root = await freshRepo();
  await initCommand(["--monorepo"]);

  const workflows = path.join(root, ".github", "workflows");
  expect(await exists(path.join(workflows, "expo-code-review.yml"))).toBe(true);
  expect(await exists(path.join(workflows, "expo-code-review-command.yml"))).toBe(true);
  expect(await exists(path.join(workflows, "expo-code-review-dismiss.yml"))).toBe(true);

  const configDir = path.join(root, CONFIG_DIRNAME);
  expect(await exists(path.join(configDir, "config.jsonc"))).toBe(true);
  expect(await exists(path.join(configDir, "coordinator.md"))).toBe(true);
  expect(await exists(path.join(configDir, "shared.md"))).toBe(true);
  expect(await exists(path.join(configDir, "agents", "security.md"))).toBe(true);
  // routing manifest (the routing template) is written with --monorepo.
  expect(await exists(path.join(configDir, "routing.jsonc"))).toBe(true);
});

test("init --no-workflow scaffolds no workflow files", async () => {
  const root = await freshRepo();
  await initCommand(["--no-workflow"]);
  expect(await exists(path.join(root, ".github", "workflows"))).toBe(false);
});

test("init --token-env rewires both review workflows to the named secret", async () => {
  const root = await freshRepo();
  await initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN"]);

  const workflows = path.join(root, ".github", "workflows");
  for (const file of ["expo-code-review.yml", "expo-code-review-command.yml"]) {
    const text = await readFile(path.join(workflows, file), "utf8");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(text).toContain("vars.ECR_EXPECTED_TOKEN_ENV || 'CLAUDE_CODE_OAUTH_TOKEN'");
    // No OpenAI wiring may survive — a leftover fallback or secret line would
    // re-open the "auth lock passes but the credential env is empty" gap.
    expect(text).not.toContain("OPENAI_API_KEY");
  }
  // dismiss.yml runs no model: written, untouched.
  expect(await readFile(path.join(workflows, "expo-code-review-dismiss.yml"), "utf8")).toBe(
    await readFile(path.join(TEMPLATES_DIR, "dismiss.yml"), "utf8"),
  );
});

// bun's spyOn(process.stdout, "write") misses writes made from other modules, so
// capture by swapping the method directly.
async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("init --token-env refuses when review workflows already exist without --force", async () => {
  const root = await freshRepo();
  await initCommand([]);
  // Wipe the config dir so we can also assert the refusal writes nothing at all.
  await rm(path.join(root, CONFIG_DIRNAME), { recursive: true, force: true });

  const err = await captureStderr(() => initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN"]));
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  expect(err).toContain("expo-code-review.yml");
  expect(err).toContain("--force");
  // No half scaffold: refused before any file was written.
  expect(await exists(path.join(root, CONFIG_DIRNAME))).toBe(false);
  // The existing workflow keeps its old wiring untouched.
  const text = await readFile(
    path.join(root, ".github", "workflows", "expo-code-review.yml"),
    "utf8",
  );
  expect(text).toContain("CLAUDE_CODE_REVIEW_SHARED_API_TOKEN");
  expect(text).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("init --token-env --force rewrites existing review workflows", async () => {
  const root = await freshRepo();
  await initCommand([]);
  await initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN", "--force"]);
  for (const file of ["expo-code-review.yml", "expo-code-review-command.yml"]) {
    const text = await readFile(path.join(root, ".github", "workflows", file), "utf8");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(text).not.toContain("CLAUDE_CODE_REVIEW_SHARED_API_TOKEN");
  }
});

test("init --token-env --force-workflows rewrites workflows but keeps customized config + prompts", async () => {
  const root = await freshRepo();
  await initCommand([]);
  // Adopter tunes their config and an agent prompt after the first scaffold.
  const configPath = path.join(root, CONFIG_DIRNAME, "config.jsonc");
  const agentPath = path.join(root, CONFIG_DIRNAME, "agents", "security.md");
  await writeFile(configPath, "// my tuned config\n", "utf8");
  await writeFile(agentPath, "my tuned prompt\n", "utf8");

  await initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN", "--force-workflows"]);

  // Workflows are rewritten for the new credential.
  for (const file of ["expo-code-review.yml", "expo-code-review-command.yml"]) {
    const text = await readFile(path.join(root, ".github", "workflows", file), "utf8");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    expect(text).not.toContain("OPENAI_API_KEY");
  }
  // The adopter's tuned files survive untouched.
  expect(await readFile(configPath, "utf8")).toBe("// my tuned config\n");
  expect(await readFile(agentPath, "utf8")).toBe("my tuned prompt\n");
});

test("init --force-workflows without --token-env refuses to revert a non-default credential", async () => {
  const root = await freshRepo();
  await initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN"]);

  // Refreshing the workflow YAML without re-passing --token-env would rewrite it
  // from the pristine (OpenAI) template and silently drop the forwarded secret.
  const err = await captureStderr(() => initCommand(["--force-workflows"]));
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  expect(err).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(err).toContain("--token-env");
  // The workflow keeps its Claude wiring untouched — no silent reversion.
  const text = await readFile(
    path.join(root, ".github", "workflows", "expo-code-review.yml"),
    "utf8",
  );
  expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(text).not.toContain("OPENAI_API_KEY");
});

test("init --force-workflows --token-env re-affirming the credential rewrites cleanly", async () => {
  const root = await freshRepo();
  await initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN"]);
  // Naming the credential again is the explicit opt-in; it must not refuse.
  await initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN", "--force-workflows"]);
  const text = await readFile(
    path.join(root, ".github", "workflows", "expo-code-review.yml"),
    "utf8",
  );
  expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  expect(text).not.toContain("OPENAI_API_KEY");
});

test("init --force-workflows refuses when only the forwarded secret line is non-default", async () => {
  const root = await freshRepo();
  await initCommand([]);
  // A repo-variable lock (vars.ECR_EXPECTED_TOKEN_ENV) leaves the YAML fallback at
  // the default while the forwarded secret line is hand-wired to a real credential.
  // The fallback alone reads as default, so the guard must also see the secret line.
  const wf = path.join(root, ".github", "workflows", "expo-code-review.yml");
  const patched = (await readFile(wf, "utf8")).replaceAll(
    "CLAUDE_CODE_REVIEW_SHARED_API_TOKEN: ${{ secrets.CLAUDE_CODE_REVIEW_SHARED_API_TOKEN }}",
    "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
  );
  await writeFile(wf, patched, "utf8");

  const err = await captureStderr(() => initCommand(["--force-workflows"]));
  expect(process.exitCode).toBe(2);
  process.exitCode = 0;
  expect(err).toContain("ANTHROPIC_API_KEY");
  expect(err).toContain("--token-env");
  // Untouched: no silent reversion to the default wiring.
  expect(await readFile(wf, "utf8")).toContain(
    "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
  );
});

test("init --force-workflows without --token-env is fine on a default-credential repo", async () => {
  const root = await freshRepo();
  await initCommand([]);
  // Default credential wiring: nothing to revert, so no refusal.
  await initCommand(["--force-workflows"]);
  expect(process.exitCode ?? 0).toBe(0);
  expect(
    await readFile(path.join(root, ".github", "workflows", "expo-code-review.yml"), "utf8"),
  ).toBe(await readFile(path.join(TEMPLATES_DIR, "workflow.yml"), "utf8"));
});

test("init --token-env prints the config.jsonc auth edit as a next step", async () => {
  await freshRepo();
  const out = await captureStdout(() => initCommand(["--token-env", "CLAUDE_CODE_OAUTH_TOKEN"]));
  // The scaffolded config.jsonc still declares the default tokenEnv, so without
  // this step CI's verify-config fails and the user has no pointer to why.
  expect(out).toContain("config.jsonc at this credential");
  expect(out).toContain("refuses to review until the config names `CLAUDE_CODE_OAUTH_TOKEN`");
});

test("init without --token-env prints no config-edit step", async () => {
  await freshRepo();
  const out = await captureStdout(() => initCommand([]));
  expect(out).not.toContain("verify-config");
});

test("init without --token-env keeps the workflow templates byte-identical", async () => {
  const root = await freshRepo();
  await initCommand([]);
  expect(
    await readFile(path.join(root, ".github", "workflows", "expo-code-review.yml"), "utf8"),
  ).toBe(await readFile(path.join(TEMPLATES_DIR, "workflow.yml"), "utf8"));
});

test("substituteTokenEnv forwards every name of a multi-credential set", async () => {
  const raw = await readFile(path.join(TEMPLATES_DIR, "command.yml"), "utf8");
  const out = substituteTokenEnv(raw, ["CODEX_OAUTH_ACCESS_TOKEN", "OPENAI_API_KEY"]);
  expect(out).toContain("vars.ECR_EXPECTED_TOKEN_ENV || 'CODEX_OAUTH_ACCESS_TOKEN,OPENAI_API_KEY'");
  expect(out).toContain("CODEX_OAUTH_ACCESS_TOKEN: ${{ secrets.CODEX_OAUTH_ACCESS_TOKEN }}");
  expect(out).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
});

test("substituteTokenEnv fails loudly when the template markers drift", () => {
  expect(() => substituteTokenEnv("jobs: {}", ["CLAUDE_CODE_OAUTH_TOKEN"])).toThrow(
    /template drifted/,
  );
});

test("parseTokenEnvs validates names and refuses well-known unrelated secrets", () => {
  expect(parseTokenEnvs(undefined)).toEqual(["CLAUDE_CODE_REVIEW_SHARED_API_TOKEN"]);
  expect(parseTokenEnvs("A_TOKEN, B_TOKEN")).toEqual(["A_TOKEN", "B_TOKEN"]);
  expect(() => parseTokenEnvs("lower_case")).toThrow(/UPPER_SNAKE_CASE/);
  expect(() => parseTokenEnvs("GH_TOKEN")).toThrow(/unrelated secret/);
  expect(() => parseTokenEnvs("BRAVE_SEARCH_API_KEY")).toThrow(/unrelated secret/);
  expect(() => parseTokenEnvs("A_TOKEN,A_TOKEN")).toThrow(/duplicate/);
});

test("every `uses:` in templates/*.yml is pinned by 40-hex commit SHA with a version comment", async () => {
  const entries = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".yml"));
  // Guard against silently testing nothing.
  expect(entries).toContain("workflow.yml");
  expect(entries).toContain("command.yml");
  expect(entries).toContain("dismiss.yml");

  const pin = /^.+@[0-9a-f]{40} # v/;
  let usesLines = 0;
  for (const file of entries) {
    const text = await readFile(path.join(TEMPLATES_DIR, file), "utf8");
    for (const raw of text.split("\n")) {
      const m = raw.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
      if (!m) continue;
      usesLines++;
      expect(m[1], `${file}: "${m[1]}" is not SHA-pinned`).toMatch(pin);
    }
  }
  // Each template pins checkout + setup-node (+ upload-artifact in workflow.yml).
  expect(usesLines).toBeGreaterThanOrEqual(7);
});

// @ref LLP 0012#what-gets-scanned [constrained-by] — a scaffold must pass `ecr ref-check` on day one
test("a freshly scaffolded repo passes ref-check", async () => {
  const root = await freshRepo();
  await initCommand(["--monorepo"]);

  // LLP annotations the templates carry belong to the engine's own corpus and are
  // skipped here, not reported: ecr only judges citations into the reviewed repo.
  expect((await checkConfigRefs({ root })).problems).toEqual([]);
});
