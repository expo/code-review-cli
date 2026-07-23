import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initCommand } from "../commands/init.js";
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
