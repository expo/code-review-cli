import { test, expect, afterEach } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { git } from "../core/exec.js";
import { LocalGitSource } from "../sources/local-git.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function commit(root: string, message: string): Promise<string> {
  return git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], root);
}

// A repo whose local git config changes what `git diff` prints: an external diff
// tool, forced color, and no `a/` and `b/` prefixes. All of them break the parser
// unless the engine overrides them.
async function repoWithDiffConfig(): Promise<string> {
  const root = await tempDir("ecr-local-git-");
  const tools = await tempDir("ecr-local-git-tools-");
  const external = path.join(tools, "external-diff");
  await writeFile(external, '#!/bin/sh\necho "external diff of $1"\n', "utf8");
  await chmod(external, 0o755);
  await git(["init", "-q"], root);
  await writeFile(path.join(root, "a.txt"), "one\n", "utf8");
  await git(["add", "a.txt"], root);
  await commit(root, "base");
  await git(["config", "diff.external", external], root);
  await git(["config", "color.diff", "always"], root);
  await git(["config", "diff.noprefix", "true"], root);
  return root;
}

test("LocalGitSource: working-tree diffs parse despite the user's diff config", async () => {
  const root = await repoWithDiffConfig();
  await writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
  await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
  const files = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  expect(files.map((file) => file.path).sort()).toEqual(["a.txt", "new.txt"]);
  expect(files.every((file) => file.patch.includes("@@"))).toBe(true);
});

test("LocalGitSource: a base...head diff parses despite the user's diff config", async () => {
  const root = await repoWithDiffConfig();
  await writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
  await git(["add", "a.txt"], root);
  await commit(root, "change");
  const files = await new LocalGitSource({
    cwd: root,
    base: "HEAD~1",
    head: "HEAD",
  }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.txt"]);
  expect(files[0]!.patch).toContain("+two");
});

test("LocalGitSource: a staged diff parses despite the user's diff config", async () => {
  const root = await repoWithDiffConfig();
  await writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
  await git(["add", "a.txt"], root);
  const files = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.txt"]);
  expect(files[0]!.patch).toContain("+two");
});
