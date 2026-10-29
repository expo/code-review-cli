import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { expectedHeadMismatch, parseExpectHead } from "../commands/ci.js";
import { resetTrustedToolCache } from "../core/exec.js";
import { GitHubPRSource, HeadMovedError } from "../sources/github-pr.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PUSHED = "89abcdef0123456789abcdef0123456789abcdef";

test("parseExpectHead: a full commit hash, lowercased; anything else is a usage error", () => {
  expect(parseExpectHead([])).toBeUndefined();
  expect(parseExpectHead(["--expect-head", HEAD.toUpperCase()])).toBe(HEAD);
  expect(() => parseExpectHead(["--expect-head", "0123456"])).toThrow("40-character");
  expect(() => parseExpectHead(["--expect-head", "--force"])).toThrow("requires a value");
  expect(() => parseExpectHead(["--expect-head"])).toThrow("requires a value");
  // Forms that would otherwise be ignored, and leave the run unpinned, fail loudly.
  expect(() => parseExpectHead([`--expect-head=${HEAD}`])).toThrow("separate argument");
  expect(() => parseExpectHead(["--expect-head", ""])).toThrow("is empty");
});

test("expectedHeadMismatch: only a named commit that is not the head stops the run", () => {
  expect(expectedHeadMismatch(undefined, HEAD)).toBeNull();
  expect(expectedHeadMismatch(undefined, undefined)).toBeNull();
  expect(expectedHeadMismatch(HEAD, HEAD)).toBeNull();
  const moved = expectedHeadMismatch(HEAD, PUSHED);
  expect(moved).toBeInstanceOf(HeadMovedError);
  expect(moved!.message).toContain("expected 0123456789ab, now 89abcdef0123");
  // An unknown head fails closed.
  expect(expectedHeadMismatch(HEAD, undefined)).toBeInstanceOf(HeadMovedError);
});

// ---- the diff is pinned to the head the metadata read, through a fake `gh` ----

// A fake `gh` that logs each call. The metadata read reports HEAD; the live head read
// after the diff reports FAKE_GH_LIVE_HEAD (HEAD when unset).
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
case "$*" in
  "pr diff"*)
    printf 'diff --git a/a.ts b/a.ts\\n'
    printf 'index 1111111..2222222 100644\\n'
    printf -- '--- a/a.ts\\n'
    printf '+++ b/a.ts\\n'
    printf '@@ -1 +1,2 @@\\n'
    printf ' one\\n'
    printf '+two\\n' ;;
  "pr view"*"--jq .headRefOid"*) printf '%s\\n' "\${FAKE_GH_LIVE_HEAD:-${HEAD}}" ;;
  "pr view"*) printf '{"headRefOid": "${HEAD}", "baseRefOid": "${PUSHED}"}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ecr-gh-pr-head-"));
  await writeFile(path.join(dir, "gh"), FAKE_GH, "utf8");
  await chmod(path.join(dir, "gh"), 0o755);
  await writeFile(path.join(dir, "calls.log"), "", "utf8");
  for (const name of ["PATH", "FAKE_GH_DIR", "FAKE_GH_LIVE_HEAD"]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_LIVE_HEAD;
  resetTrustedToolCache();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetTrustedToolCache();
  await rm(dir, { recursive: true, force: true });
});

test("getChangedFiles: the head is read again after the diff, and an unmoved head returns it", async () => {
  const files = await new GitHubPRSource({ prNumber: 7, repo: "o/r" }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.ts"]);
  const calls = (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
  // Metadata first, then the diff, then the live head.
  expect(calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
    "pr view",
    "pr diff",
    "pr view",
  ]);
  expect(calls[2]).toContain("--json headRefOid");
});

test("getChangedFiles: a push between the metadata read and the diff throws HeadMovedError", async () => {
  process.env.FAKE_GH_LIVE_HEAD = PUSHED;
  const source = new GitHubPRSource({ prNumber: 7, repo: "o/r" });
  const error = await source.getChangedFiles().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HeadMovedError);
  expect((error as HeadMovedError).expected).toBe(HEAD);
  expect((error as HeadMovedError).actual).toBe(PUSHED);
});
