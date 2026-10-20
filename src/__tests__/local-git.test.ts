import { test, expect, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Fixture commits must not depend on the developer's global git config: signing or a
// global hooks path would fail them before any assertion runs.
function commit(root: string, message: string): Promise<string> {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
  return git(
    [...identity, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message],
    root,
  );
}

async function executable(dir: string, name: string, script: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, script, "utf8");
  await chmod(file, 0o755);
  return file;
}

// A committed repo with `a.txt` and `b/inner.txt`. The `b/` path matters: with no
// prefixes, `+++ b/inner.txt` loses its directory to the parser's `b/` strip.
async function baseRepo(): Promise<string> {
  const root = await tempDir("ecr-local-git-");
  await git(["init", "-q"], root);
  await mkdir(path.join(root, "b"));
  await writeFile(path.join(root, "a.txt"), "one\n", "utf8");
  await writeFile(path.join(root, "b", "inner.txt"), "inner\n", "utf8");
  await git(["add", "-A"], root);
  await commit(root, "base");
  return root;
}

// A repo whose local git config changes what `git diff` prints: an external diff
// tool, forced color, and no `a/` and `b/` prefixes. All of them break the parser
// unless the engine overrides them.
async function repoWithDiffConfig(): Promise<string> {
  const root = await baseRepo();
  const tools = await tempDir("ecr-local-git-tools-");
  const external = await executable(
    tools,
    "external-diff",
    '#!/bin/sh\necho "external diff of $1"\n',
  );
  await git(["config", "diff.external", external], root);
  await git(["config", "color.diff", "always"], root);
  await git(["config", "diff.noprefix", "true"], root);
  return root;
}

async function editBoth(root: string): Promise<void> {
  await writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
  await writeFile(path.join(root, "b", "inner.txt"), "inner\nmore\n", "utf8");
}

test("LocalGitSource: working-tree diffs parse despite the user's diff config", async () => {
  const root = await repoWithDiffConfig();
  await editBoth(root);
  await writeFile(path.join(root, "b", "new.txt"), "new\n", "utf8");
  const files = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  expect(files.map((file) => file.path).sort()).toEqual(["a.txt", "b/inner.txt", "b/new.txt"]);
  expect(files.every((file) => file.patch.includes("@@"))).toBe(true);
});

test("LocalGitSource: a base...head diff parses despite the user's diff config", async () => {
  const root = await repoWithDiffConfig();
  await editBoth(root);
  await git(["add", "-A"], root);
  await commit(root, "change");
  const files = await new LocalGitSource({
    cwd: root,
    base: "HEAD~1",
    head: "HEAD",
  }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.txt", "b/inner.txt"]);
  expect(files[0]!.patch).toContain("+two");
});

test("LocalGitSource: a staged diff parses despite the user's diff config", async () => {
  const root = await repoWithDiffConfig();
  await editBoth(root);
  await git(["add", "-A"], root);
  const files = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.txt", "b/inner.txt"]);
  expect(files[0]!.patch).toContain("+two");
});

test("LocalGitSource: diff.mnemonicPrefix doesn't rename working-tree, untracked or staged paths", async () => {
  // Mnemonic prefixes are `c/` and `w/` for the working tree, `2/` for --no-index,
  // and `i/` for the index, none of which the parser strips.
  const root = await baseRepo();
  await git(["config", "diff.mnemonicPrefix", "true"], root);
  await editBoth(root);
  await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
  const working = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  expect(working.map((file) => file.path).sort()).toEqual(["a.txt", "b/inner.txt", "new.txt"]);
  await git(["add", "-A"], root);
  const staged = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  expect(staged.map((file) => file.path)).toEqual(["a.txt", "b/inner.txt", "new.txt"]);
});

test("LocalGitSource: a textconv driver can't replace or hide the real change", async () => {
  // A driver that prints a constant makes both sides identical, so with textconv on
  // the change to a.txt vanishes from the review.
  const root = await baseRepo();
  const tools = await tempDir("ecr-local-git-tools-");
  const mask = await executable(tools, "mask", "#!/bin/sh\necho masked\n");
  await writeFile(path.join(root, ".git", "info", "attributes"), "*.txt diff=mask\n", "utf8");
  await git(["config", "diff.mask.textconv", mask], root);
  await editBoth(root);
  const files = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.txt", "b/inner.txt"]);
  expect(files[0]!.patch).toContain("+two");
  expect(files[0]!.patch).not.toContain("masked");
});

test("LocalGitSource: copy detection can't turn a new file into an empty modification", async () => {
  // With diff.renames=copies, an exact copy of a file the change also edits comes out
  // as `copy from`/`copy to` with no hunk, so the new file's contents go unreviewed.
  const root = await baseRepo();
  await git(["config", "diff.renames", "copies"], root);
  await writeFile(path.join(root, "b", "copy.txt"), "inner\n", "utf8");
  await writeFile(path.join(root, "b", "inner.txt"), "inner\nmore\n", "utf8");
  await git(["add", "-A"], root);
  const files = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  const copy = files.find((file) => file.path === "b/copy.txt");
  expect(copy?.status).toBe("A");
  expect(copy?.patch).toContain("+inner");
});
