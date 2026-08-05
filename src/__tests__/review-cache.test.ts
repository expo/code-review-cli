import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoadedConfig } from "../config/schema.js";
import { reviewCanBeReused, reviewInputHash, reviewMatchesInput } from "../core/review-cache.js";
import type { CoordinatorOutput, DiffEntry } from "../core/schema.js";

const config = (over: Partial<LoadedConfig> = {}): LoadedConfig => ({
  configDir: "/tmp/config-a",
  sharedPromptText: "shared rules",
  agents: [
    {
      id: "correctness",
      description: "bugs",
      alwaysRun: false,
      model: "anthropic/claude-sonnet-5",
      temperature: 0.1,
      tools: { read: true },
      promptText: "find bugs",
    },
  ],
  coordinator: {
    model: "anthropic/claude-sonnet-5",
    temperature: 0,
    promptText: "dedupe",
  },
  policy: { includeSuggestions: false },
  chunk: { maxChangedLines: 1000, maxFiles: 20 },
  noise: { additionalIgnores: [], additionalMarkers: [] },
  breakGlassMarker: "/skip-review",
  commentTag: "review",
  auth: [{ provider: "anthropic", mode: "oauth", tokenEnv: "TOKEN" }],
  review: { trigger: "all", label: "ai-review", skipLabel: "ai-review:skip" },
  stack: {
    enabled: false,
    maxDepth: 4,
    maxPrs: 8,
    maxFilesPerPr: 100,
    requireSameAuthor: true,
    confirmWithPatch: false,
    maxConfirmations: 10,
  },
  feedback: {
    mode: "annotate",
    match: "both",
    dismiss: "never",
    protectedCategories: ["security", "secrets"],
    maxAdjudications: 10,
  },
  ...over,
});

const files: DiffEntry[] = [
  {
    path: "b.ts",
    patch: "diff --git a/b.ts b/b.ts\nindex 111..222 100644\n@@ -1 +1 @@\n-old\n+new",
    status: "M",
  },
  { path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+export {};", status: "A" },
];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-review-cache-test-"));
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "a.ts"), "export {};\n"),
    writeFile(path.join(root, "b.ts"), "new\n"),
  ]);
  return root;
}

const hash = (
  readRoot: string,
  over: Partial<Parameters<typeof reviewInputHash>[0]> = {},
): Promise<string> =>
  reviewInputHash({
    files,
    config: config(),
    metadata: { title: "Change", body: "Why" },
    readRoot,
    agents: ["security", "correctness"],
    route: true,
    contextText: "plan",
    ...over,
  });

test("review input hash ignores restack-only blob ids, hunk offsets, and ordering", async () => {
  const root = await fixtureRoot();
  try {
    const first = await hash(root);
    const restacked = files.map((file) =>
      file.path === "b.ts"
        ? { ...file, patch: file.patch.replace("111..222", "aaa..bbb").replace("-1 +1", "-9 +9") }
        : file,
    );
    const second = await hash(root, {
      files: restacked.reverse(),
      config: config({ configDir: "/another/ephemeral/base-worktree" }),
      agents: ["correctness", "security"],
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review input hash changes with code, prompts, PR prose, selection, or context", async () => {
  const root = await fixtureRoot();
  try {
    const original = await hash(root);
    expect(
      await hash(root, { files: [{ ...files[0]!, patch: "+different" }, files[1]!] }),
    ).not.toBe(original);
    await writeFile(path.join(root, "b.ts"), "different\n");
    expect(await hash(root)).not.toBe(original);
    await writeFile(path.join(root, "b.ts"), "new\n");
    expect(await hash(root, { config: config({ sharedPromptText: "new rules" }) })).not.toBe(
      original,
    );
    expect(await hash(root, { metadata: { title: "Renamed", body: "Why" } })).not.toBe(original);
    expect(await hash(root, { agents: ["correctness"] })).not.toBe(original);
    expect(await hash(root, { route: false })).not.toBe(original);
    expect(await hash(root, { contextText: "new plan" })).not.toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const review = (over: Partial<CoordinatorOutput> = {}): CoordinatorOutput => ({
  decision: "approve",
  findings: [],
  summary: "ok",
  incomplete: [],
  ...over,
});

test("only a complete review with the exact stored hash can be reused", async () => {
  const root = await fixtureRoot();
  try {
    const current = await hash(root);
    expect(reviewCanBeReused(review())).toBe(true);
    expect(reviewMatchesInput(review(), current, current)).toBe(true);
    expect(reviewMatchesInput(review(), "bad", current)).toBe(false);
    expect(reviewMatchesInput(review({ incomplete: ["timed out"] }), current, current)).toBe(false);
    expect(reviewMatchesInput(review({ couldNotComplete: true }), current, current)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file hashing refuses traversal and never follows a PR-controlled symlink", async () => {
  const root = await fixtureRoot();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-secret`);
  try {
    await writeFile(outside, "secret one\n");
    await symlink(outside, path.join(root, "link"));
    const link: DiffEntry = { path: "link", patch: "diff --git a/link b/link", status: "A" };
    const first = await hash(root, { files: [link] });
    await writeFile(outside, "secret two\n");
    expect(await hash(root, { files: [link] })).toBe(first);
    await expect(
      hash(root, {
        files: [{ path: "../outside", patch: "diff --git a/x b/x", status: "A" }],
      }),
    ).rejects.toThrow("escapes the PR tree");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
