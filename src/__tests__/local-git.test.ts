import { test, expect, afterAll, afterEach, beforeAll } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { git } from "../core/exec.js";
import { LocalGitSource } from "../sources/local-git.js";

// This file's fixture git must stay inside its temp repos. Git exports GIT_DIR,
// GIT_INDEX_FILE and friends to hooks, so `bun test` run from a pre-commit hook would
// otherwise write these fixtures into the commit being made. The user's global and
// system git files (signing, a hooks path, init templates, a global ignore or
// attributes file) could also fail the fixtures before any assertion runs, so HOME and
// XDG_CONFIG_HOME point at an empty directory, which works on every git version.
const savedEnv: Record<string, string | undefined> = {};
// Set only once mkdtemp succeeds: afterAll runs even when beforeAll throws, and must
// never remove whatever HOME still points at.
let fakeHome: string | undefined;
beforeAll(async () => {
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("GIT_")) {
      savedEnv[name] = value;
      delete process.env[name];
    }
  }
  fakeHome = await mkdtemp(path.join(tmpdir(), "ecr-local-git-home-"));
  for (const [name, value] of [
    ["HOME", fakeHome],
    ["XDG_CONFIG_HOME", fakeHome],
    ["GIT_CONFIG_NOSYSTEM", "1"],
  ] as const) {
    savedEnv[name] ??= process.env[name];
    process.env[name] = value;
  }
});
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (fakeHome) {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

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

async function repoWithMnemonicPrefix(): Promise<string> {
  const root = await baseRepo();
  await git(["config", "diff.mnemonicPrefix", "true"], root);
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
  const root = await repoWithMnemonicPrefix();
  await editBoth(root);
  await writeFile(path.join(root, "new.txt"), "new\n", "utf8");
  const working = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  expect(working.map((file) => file.path).sort()).toEqual(["a.txt", "b/inner.txt", "new.txt"]);
  await git(["add", "-A"], root);
  const staged = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  expect(staged.map((file) => file.path)).toEqual(["a.txt", "b/inner.txt", "new.txt"]);
});

// Only a deletion takes its path from the `---` line, so only a deletion shows a wrong
// source prefix: `--- b/inner.txt` would lose its directory, and `--- c/b/inner.txt`
// would keep a `c/` that isn't part of the path.
test.each([
  ["diff.noprefix", repoWithDiffConfig],
  ["diff.mnemonicPrefix", repoWithMnemonicPrefix],
])("LocalGitSource: a deleted file keeps its path under %s", async (_config, makeRepo) => {
  const root = await makeRepo();
  await rm(path.join(root, "b", "inner.txt"));
  const working = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  await git(["add", "-A"], root);
  const staged = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  await commit(root, "delete");
  const range = await new LocalGitSource({
    cwd: root,
    base: "HEAD~1",
    head: "HEAD",
  }).getChangedFiles();
  for (const files of [working, staged, range]) {
    expect(files.map((file) => [file.status, file.path])).toEqual([["D", "b/inner.txt"]]);
  }
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

// `diff.submodule=log` prints `Submodule sub <old>..<new>:` and commit subjects instead
// of a diff, so the change parses as nothing. `diff.submodule=diff` prints the
// submodule's own file diffs, so the review sees `sub/s.txt` instead of the pointer
// change the commit makes. `diff.ignoreSubmodules=all`, or `ignore = all` in
// `.gitmodules`, drops the change entirely.
async function repoWithSubmodule(): Promise<{ root: string; sub: string }> {
  const root = await baseRepo();
  const sub = path.join(root, "sub");
  await mkdir(sub);
  await git(["init", "-q"], sub);
  await writeFile(path.join(sub, "s.txt"), "one\n", "utf8");
  await git(["add", "-A"], sub);
  await commit(sub, "s1");
  await git(["add", "sub"], root);
  await commit(root, "add sub");
  return { root, sub };
}

test.each([
  ["diff.submodule=log", ["config", "diff.submodule", "log"]],
  ["diff.submodule=diff", ["config", "diff.submodule", "diff"]],
  ["diff.ignoreSubmodules=all", ["config", "diff.ignoreSubmodules", "all"]],
  [".gitmodules ignore = all", ["config", "-f", ".gitmodules", "submodule.sub.ignore", "all"]],
])("LocalGitSource: %s still shows a submodule change as its pointer", async (_name, setting) => {
  const { root, sub } = await repoWithSubmodule();
  await writeFile(path.join(sub, "s.txt"), "two\n", "utf8");
  await git(["add", "-A"], sub);
  await commit(sub, "s2");
  await git(setting, root);
  if (setting.includes(".gitmodules")) {
    await git(["config", "-f", ".gitmodules", "submodule.sub.path", "sub"], root);
    await git(["add", ".gitmodules"], root);
    await commit(root, "ignore sub");
  }
  const working = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  // `git add` skips a submodule that `.gitmodules` ignores unless forced.
  await git(["add", "--force", "sub"], root);
  const staged = await new LocalGitSource({ cwd: root, staged: true }).getChangedFiles();
  await commit(root, "bump sub");
  const range = await new LocalGitSource({
    cwd: root,
    base: "HEAD~1",
    head: "HEAD",
  }).getChangedFiles();
  for (const files of [working, staged, range]) {
    expect(files.map((file) => [file.status, file.path])).toEqual([["M", "sub"]]);
    expect(files[0]!.patch).toContain("+Subproject commit");
  }
});

// Edits inside a submodule whose pointer didn't move aren't a change to review, even
// under a user's `diff.ignoreSubmodules=none`.
test("LocalGitSource: a submodule with local edits but the same pointer isn't a change", async () => {
  const { root, sub } = await repoWithSubmodule();
  await git(["config", "diff.ignoreSubmodules", "none"], root);
  await writeFile(path.join(sub, "s.txt"), "edited\n", "utf8");
  await writeFile(path.join(sub, "untracked.txt"), "new\n", "utf8");
  const files = await new LocalGitSource({ cwd: root, base: "HEAD" }).getChangedFiles();
  expect(files).toEqual([]);
});
