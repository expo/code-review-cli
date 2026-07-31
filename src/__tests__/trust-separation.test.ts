import { test, expect } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isAmbientRuntimeConfig,
  removeEscapingSymlinks,
  scrubAmbientRuntimeConfig,
} from "../core/scrub.js";
import { isCommitOid } from "../sources/github-pr.js";
import { hasScopeConfig } from "../config/load.js";
import { resolveReadRoot } from "../core/review.js";
import type { PreparedReadRoot, ReviewSource } from "../sources/source.js";

// ---------------------------------------------------------------------------
// scrub: ambient runtime config never reaches the model runtime's project root
// ---------------------------------------------------------------------------

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

async function makeTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-scrub-test-"));
  const put = async (rel: string, dir = false): Promise<void> => {
    const full = path.join(root, rel);
    if (dir) {
      await mkdir(full, { recursive: true });
    } else {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, "x", "utf8");
    }
  };
  // Ambient runtime config at several depths (all attacker-writable in a PR).
  await put("opencode.json");
  await put("AGENTS.md");
  await put("CLAUDE.md");
  await put(".env");
  await put(".env.local");
  await put(".mcp.json");
  await put(".cursorrules");
  await put(".opencode/plugin/evil.js");
  await put(".claude/settings.json");
  await put(".cursor/rules/x.md");
  await put("packages/app/opencode.jsonc");
  await put("packages/app/AGENTS.md");
  await put("packages/app/.env.production");
  // Legitimate source content that must survive.
  await put("src/index.ts");
  await put("packages/app/src/main.ts");
  await put("README.md");
  await put("environment.ts"); // not a .env file
  // Never descended into / never removed as a unit.
  await put(".git/config");
  await put("node_modules/dep/AGENTS.md");
  return root;
}

test("scrubAmbientRuntimeConfig removes runtime config at every depth and keeps source", async () => {
  const root = await makeTree();
  const removed = await scrubAmbientRuntimeConfig(root);

  for (const gone of [
    "opencode.json",
    "AGENTS.md",
    "CLAUDE.md",
    ".env",
    ".env.local",
    ".mcp.json",
    ".cursorrules",
    ".opencode",
    ".claude",
    ".cursor",
    "packages/app/opencode.jsonc",
    "packages/app/AGENTS.md",
    "packages/app/.env.production",
  ]) {
    expect(await exists(path.join(root, gone))).toBe(false);
  }
  for (const kept of ["src/index.ts", "packages/app/src/main.ts", "README.md", "environment.ts"]) {
    expect(await exists(path.join(root, kept))).toBe(true);
  }
  // .git is the worktree link back to the real repo; node_modules is skipped.
  expect(await exists(path.join(root, ".git/config"))).toBe(true);
  expect(await exists(path.join(root, "node_modules/dep/AGENTS.md"))).toBe(true);
  // Removed paths are reported (repo-relative) so runs can log them.
  expect(removed).toContain("opencode.json");
  expect(removed).toContain(path.join("packages", "app", "AGENTS.md"));
  expect(removed).not.toContain("README.md");
});

test("isAmbientRuntimeConfig: exact names, .env prefix family, nothing else", () => {
  for (const name of [
    "opencode.json",
    ".opencode",
    "AGENTS.md",
    ".env",
    ".env.local",
    ".mcp.json",
  ]) {
    expect(isAmbientRuntimeConfig(name)).toBe(true);
  }
  for (const name of [
    "environment.ts",
    "env.ts",
    "opencode.json.bak",
    "agents.md.txt",
    "README.md",
  ]) {
    expect(isAmbientRuntimeConfig(name)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// symlink sweep: a PR-committed link cannot read outside the materialized tree
// ---------------------------------------------------------------------------

const isLink = async (p: string): Promise<boolean> =>
  lstat(p).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );

test("removeEscapingSymlinks strips out-of-tree and broken links, keeps in-tree ones", async () => {
  // A sibling directory OUTSIDE the tree stands in for the host filesystem
  // (~/.claude/.credentials.json in the real attack).
  const parent = await mkdtemp(path.join(tmpdir(), "ecr-symlink-test-"));
  const root = path.join(parent, "tree");
  const outside = path.join(parent, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "credential", "utf8");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "node_modules/dep"), { recursive: true });
  await writeFile(path.join(root, "target.txt"), "in-tree", "utf8");

  // Escaping: absolute, relative, nested under node_modules, and a chain whose
  // FIRST hop is in-tree but whose final target is not.
  await symlink(path.join(outside, "secret.txt"), path.join(root, "abs-escape"));
  await symlink("../outside/secret.txt", path.join(root, "docs/rel-escape"));
  await symlink(path.join(outside, "secret.txt"), path.join(root, "node_modules/dep/escape"));
  await symlink("abs-escape", path.join(root, "chain-escape"));
  // Broken link (fail closed) and legitimate in-tree links (direct + chained).
  await symlink(path.join(root, "missing.txt"), path.join(root, "broken"));
  await symlink("target.txt", path.join(root, "in-tree-alias"));
  await symlink("in-tree-alias", path.join(root, "in-tree-chain"));

  const removed = await removeEscapingSymlinks(root);

  for (const gone of [
    "abs-escape",
    path.join("docs", "rel-escape"),
    path.join("node_modules", "dep", "escape"),
    "chain-escape",
    "broken",
  ]) {
    expect(removed).toContain(gone);
    expect(await isLink(path.join(root, gone))).toBe(false);
  }
  // In-tree links survive and still resolve; regular files are untouched.
  expect(removed).not.toContain("in-tree-alias");
  expect(removed).not.toContain("in-tree-chain");
  expect(await isLink(path.join(root, "in-tree-alias"))).toBe(true);
  expect(await readFile(path.join(root, "in-tree-chain"), "utf8")).toBe("in-tree");
  expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("in-tree");
  // The out-of-tree target itself is never touched — only the links to it.
  expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("credential");
});

test("removeEscapingSymlinks keeps an in-tree directory link without descending it", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "ecr-symlink-test-"));
  const root = path.join(parent, "tree");
  await mkdir(path.join(root, "real-dir"), { recursive: true });
  await writeFile(path.join(root, "real-dir/file.txt"), "x", "utf8");
  // In-tree directory alias, plus a self-cycle that must not hang the walk.
  await symlink(path.join(root, "real-dir"), path.join(root, "dir-alias"));
  await symlink(path.join(root, "cycle"), path.join(root, "cycle"));

  const removed = await removeEscapingSymlinks(root);

  expect(removed).toEqual(["cycle"]); // self-cycle is unresolvable -> fail closed
  expect(await isLink(path.join(root, "dir-alias"))).toBe(true);
  expect(await readFile(path.join(root, "dir-alias/file.txt"), "utf8")).toBe("x");
});

// ---------------------------------------------------------------------------
// OIDs: only full commit hashes reach security-sensitive git calls
// ---------------------------------------------------------------------------

test("isCommitOid accepts only full 40-hex commit hashes", () => {
  expect(isCommitOid("a".repeat(40))).toBe(true);
  expect(isCommitOid("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  expect(isCommitOid("0123456789ABCDEF0123456789ABCDEF01234567")).toBe(true);
  expect(isCommitOid("a".repeat(39))).toBe(false); // short
  expect(isCommitOid("a".repeat(41))).toBe(false); // long
  expect(isCommitOid("main")).toBe(false); // branch name
  expect(isCommitOid("refs/pull/1/head")).toBe(false); // ref
  expect(isCommitOid("--upload-pack=evil")).toBe(false); // argument injection
  expect(isCommitOid(undefined)).toBe(false);
  expect(isCommitOid("")).toBe(false);
});

// ---------------------------------------------------------------------------
// resolveReadRoot: CI fails closed, local degrades softly, null is never an error
// ---------------------------------------------------------------------------

const sourceWith = (
  prepare: (() => Promise<PreparedReadRoot | null>) | undefined,
): ReviewSource => ({
  getMetadata: async () => ({ title: "", body: "", baseRef: "", headRef: "" }),
  getChangedFiles: async () => [],
  ...(prepare ? { prepareReadRootAsync: prepare } : {}),
});

test("resolveReadRoot: materialization failure is fatal in ci mode", async () => {
  const source = sourceWith(async () => {
    throw new Error("fetch failed");
  });
  await expect(resolveReadRoot(source, "ci", () => {})).rejects.toThrow(
    /trusted base|fetch failed/,
  );
});

test("resolveReadRoot: materialization failure falls back softly in local mode", async () => {
  const messages: string[] = [];
  const source = sourceWith(async () => {
    throw new Error("fetch failed");
  });
  const root = await resolveReadRoot(source, "local", (m) => messages.push(m));
  expect(root).toBeNull();
  expect(messages.join("\n")).toContain("fetch failed");
});

test("resolveReadRoot: null (nothing to materialize) is fine in every mode", async () => {
  const source = sourceWith(async () => null);
  expect(await resolveReadRoot(source, "ci", () => {})).toBeNull();
  expect(await resolveReadRoot(source, "local", () => {})).toBeNull();
  expect(await resolveReadRoot(sourceWith(undefined), "ci", () => {})).toBeNull();
});

test("resolveReadRoot: a materialized root passes through untouched", async () => {
  const handle: PreparedReadRoot = { dir: "/tmp/x", cleanup: async () => {} };
  const source = sourceWith(async () => handle);
  expect(await resolveReadRoot(source, "ci", () => {})).toBe(handle);
});

// ---------------------------------------------------------------------------
// hasScopeConfig: scope-miss detection against the trusted base root
// ---------------------------------------------------------------------------

test("hasScopeConfig: default scope always exists; nested scope needs config.json(c) at the root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-scope-test-"));
  const scope = { name: "app", config: "packages/app", include: ["packages/app/**"] };

  expect(hasScopeConfig(root, { ...scope, config: "." })).toBe(true);
  expect(hasScopeConfig(root, scope)).toBe(false); // absent from base → miss

  await mkdir(path.join(root, "packages/app/.expo-code-review"), { recursive: true });
  expect(hasScopeConfig(root, scope)).toBe(false); // dir alone isn't a config
  await writeFile(path.join(root, "packages/app/.expo-code-review/config.jsonc"), "{}", "utf8");
  expect(hasScopeConfig(root, scope)).toBe(true);
});
