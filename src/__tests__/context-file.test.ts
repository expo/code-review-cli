import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readContextFile, MAX_CONTEXT_FILE_BYTES } from "../core/context-file.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-ctx-"));
  dirs.push(dir);
  return dir;
}

test("readContextFile returns file text", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "plan.txt");
  await writeFile(file, "Plan: 1 to add, 0 to change, 0 to destroy.\n");
  expect(await readContextFile(file)).toContain("Plan: 1 to add");
});

test("readContextFile throws on missing file", async () => {
  const dir = await tmpDir();
  await expect(readContextFile(path.join(dir, "nope.txt"))).rejects.toThrow();
});

test("readContextFile throws over the byte ceiling", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "huge.txt");
  await writeFile(file, "x".repeat(MAX_CONTEXT_FILE_BYTES + 1));
  await expect(readContextFile(file)).rejects.toThrow(/too large/);
});

test("readContextFile bounds special files that stat as small but read without end", async () => {
  // /dev/zero reports size 0; a stat-based check would pass it and the read
  // would then grow until OOM. The in-read ceiling must throw instead.
  await expect(readContextFile("/dev/zero")).rejects.toThrow(/too large/);
});
