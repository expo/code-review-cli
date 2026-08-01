import { test, expect } from "bun:test";

import { parseChildFileNdjson, walkUpstack } from "../sources/github-pr.js";
import type { StackChildFiles, StackChildPr } from "../sources/github-pr.js";
import type { StackWalkOptions } from "../sources/source.js";

const opts = (over: Partial<StackWalkOptions> = {}): StackWalkOptions => ({
  maxDepth: 4,
  maxPrs: 8,
  maxFilesPerPr: 100,
  requireSameAuthor: true,
  ...over,
});

const child = (over: Partial<StackChildPr>): StackChildPr => ({
  number: 1,
  title: "child",
  authorLogin: "alice",
  headRef: "feat-a",
  sameRepo: true,
  ...over,
});

/** Build fetchers over a branch → children map, and a fixed file list per PR. */
function fetchers(
  byBase: Record<string, StackChildPr[]>,
  filesByPr: Record<number, StackChildFiles> = {},
): {
  fetchChildren: (base: string) => Promise<StackChildPr[]>;
  fetchFiles: (n: number) => Promise<StackChildFiles>;
} {
  return {
    fetchChildren: async (base) => byBase[base] ?? [],
    fetchFiles: async (n) => filesByPr[n] ?? { files: [`file-${n}.ts`], truncated: false },
  };
}

test("walkUpstack: discovers a multi-level stack in order", async () => {
  const { fetchChildren, fetchFiles } = fetchers({
    "root-head": [child({ number: 10, headRef: "level-1" })],
    "level-1": [child({ number: 11, headRef: "level-2" })],
    "level-2": [child({ number: 12, headRef: "level-3" })],
  });
  const manifest = await walkUpstack("root-head", "alice", opts(), fetchChildren, fetchFiles);
  expect(manifest?.upstackPRs.map((pr) => pr.number)).toEqual([10, 11, 12]);
  expect(manifest?.truncated).toBe(false);
});

test("walkUpstack: empty stack returns null (fail-open, nothing to inject)", async () => {
  const { fetchChildren, fetchFiles } = fetchers({});
  expect(await walkUpstack("root-head", "alice", opts(), fetchChildren, fetchFiles)).toBeNull();
});

test("walkUpstack: a fetch error returns null (fail-open)", async () => {
  const manifest = await walkUpstack(
    "root-head",
    "alice",
    opts(),
    async () => {
      throw new Error("gh rate limited");
    },
    async () => ({ files: [], truncated: false }),
  );
  expect(manifest).toBeNull();
});

test("walkUpstack: drops fork (cross-repo) children", async () => {
  const { fetchChildren, fetchFiles } = fetchers({
    "root-head": [
      child({ number: 20, headRef: "fork", sameRepo: false }),
      child({ number: 21, headRef: "same", sameRepo: true }),
    ],
  });
  const manifest = await walkUpstack("root-head", "alice", opts(), fetchChildren, fetchFiles);
  expect(manifest?.upstackPRs.map((pr) => pr.number)).toEqual([21]);
});

test("walkUpstack: same-author gate drops other authors when required", async () => {
  const { fetchChildren, fetchFiles } = fetchers({
    "root-head": [
      child({ number: 30, headRef: "mine", authorLogin: "alice" }),
      child({ number: 31, headRef: "theirs", authorLogin: "mallory" }),
    ],
  });
  const strict = await walkUpstack("root-head", "alice", opts(), fetchChildren, fetchFiles);
  expect(strict?.upstackPRs.map((pr) => pr.number)).toEqual([30]);

  const loose = await walkUpstack(
    "root-head",
    "alice",
    opts({ requireSameAuthor: false }),
    fetchChildren,
    fetchFiles,
  );
  expect(loose?.upstackPRs.map((pr) => pr.number)).toEqual([30, 31]);
});

test("walkUpstack: caps children per level at maxPrs", async () => {
  const many = Array.from({ length: 10 }, (_, i) => child({ number: 100 + i, headRef: `h${i}` }));
  const { fetchChildren, fetchFiles } = fetchers({ "root-head": many });
  const manifest = await walkUpstack(
    "root-head",
    "alice",
    opts({ maxPrs: 3 }),
    fetchChildren,
    fetchFiles,
  );
  expect(manifest?.upstackPRs.length).toBe(3);
});

test("walkUpstack: stops at maxDepth", async () => {
  const { fetchChildren, fetchFiles } = fetchers({
    "root-head": [child({ number: 40, headRef: "d1" })],
    d1: [child({ number: 41, headRef: "d2" })],
    d2: [child({ number: 42, headRef: "d3" })],
  });
  const manifest = await walkUpstack(
    "root-head",
    "alice",
    opts({ maxDepth: 2 }),
    fetchChildren,
    fetchFiles,
  );
  expect(manifest?.upstackPRs.map((pr) => pr.number)).toEqual([40, 41]);
});

test("walkUpstack: cycle guard stops a branch that points back at a visited head", async () => {
  const { fetchChildren, fetchFiles } = fetchers({
    "root-head": [child({ number: 50, headRef: "a" })],
    a: [child({ number: 51, headRef: "b" })],
    // b points back at 'a' — must not re-add PR 50/loop forever.
    b: [child({ number: 52, headRef: "a" })],
  });
  const manifest = await walkUpstack("root-head", "alice", opts(), fetchChildren, fetchFiles);
  expect(manifest?.upstackPRs.map((pr) => pr.number)).toEqual([50, 51]);
});

test("walkUpstack: propagates a per-child file truncation flag", async () => {
  const { fetchChildren } = fetchers({ "root-head": [child({ number: 60, headRef: "t" })] });
  const manifest = await walkUpstack("root-head", "alice", opts(), fetchChildren, async () => ({
    files: ["only-shown.ts"],
    truncated: true,
  }));
  expect(manifest?.truncated).toBe(true);
  expect(manifest?.upstackPRs[0]!.files).toEqual(["only-shown.ts"]);
});

test("walkUpstack: maxPrs is a per-LEVEL budget shared across parents, not per-parent", async () => {
  // A branching (diamond) stack: the root has two children, and each of those has
  // two children at depth 2. With maxPrs=2 the second level must keep 2 PRs TOTAL,
  // not 2 per parent (which would be 4 and compound with depth).
  const { fetchChildren, fetchFiles } = fetchers({
    "root-head": [child({ number: 10, headRef: "a" }), child({ number: 11, headRef: "b" })],
    a: [child({ number: 20, headRef: "a1" }), child({ number: 21, headRef: "a2" })],
    b: [child({ number: 22, headRef: "b1" }), child({ number: 23, headRef: "b2" })],
  });
  const manifest = await walkUpstack(
    "root-head",
    "alice",
    opts({ maxPrs: 2 }),
    fetchChildren,
    fetchFiles,
  );
  // Level 1: 10, 11 (2 = the budget). Level 2: only 20, 21 — parent "b" gets nothing.
  expect(manifest?.upstackPRs.map((pr) => pr.number)).toEqual([10, 11, 20, 21]);
});

test("parseChildFileNdjson: a newline inside a filename cannot forge a second entry", () => {
  // gh --jq objects keep the newline escaped inside one NDJSON line; the parser
  // must drop the whole name (control chars disqualify), never split it in two.
  const stdout = [
    JSON.stringify({ filename: "src/real.ts" }),
    JSON.stringify({ filename: "docs/note\nsrc/core/forged.ts" }),
    JSON.stringify({ filename: "src/other.ts" }),
  ].join("\n");
  expect(parseChildFileNdjson(stdout)).toEqual(["src/real.ts", "src/other.ts"]);
});

test("parseChildFileNdjson: blank lines and missing filenames are skipped", () => {
  const stdout = `\n${JSON.stringify({ filename: "a.ts" })}\n\n${JSON.stringify({})}\n`;
  expect(parseChildFileNdjson(stdout)).toEqual(["a.ts"]);
});
