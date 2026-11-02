import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { expectedHeadMismatch, parseExpectHead } from "../commands/ci.js";
import { resetTrustedToolCache } from "../core/exec.js";
import { GitHubPRSource } from "../sources/github-pr.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";

test("parseExpectHead: a full commit hash, lowercased; anything else is a usage error", () => {
  expect(parseExpectHead([])).toBeUndefined();
  expect(parseExpectHead(["--expect-head", HEAD.toUpperCase()])).toBe(HEAD);
  expect(() => parseExpectHead(["--expect-head", "0123456"])).toThrow("40-character");
  expect(() => parseExpectHead(["--expect-head", "--force"])).toThrow("requires a value");
  expect(() => parseExpectHead(["--expect-head"])).toThrow("requires a value");
  // Forms that would otherwise be ignored, and leave the run unpinned, fail loudly.
  expect(() => parseExpectHead([`--expect-head=${HEAD}`])).toThrow("separate argument");
  expect(() => parseExpectHead(["--expect-head", ""])).toThrow("is empty");
  expect(() => parseExpectHead(["--expect-head", HEAD, "--expect-head", ""])).toThrow(
    "more than once",
  );
});

test("expectedHeadMismatch: only a named commit that is not the head stops the run", () => {
  expect(expectedHeadMismatch(undefined, HEAD)).toBeNull();
  expect(expectedHeadMismatch(undefined, undefined)).toBeNull();
  expect(expectedHeadMismatch(HEAD, HEAD)).toBeNull();
  expect(expectedHeadMismatch(HEAD, BASE)).toBe(
    `the PR's head is ${BASE}, not ${HEAD}, the commit this review was requested for`,
  );
  // An unknown head fails closed.
  expect(expectedHeadMismatch(HEAD, undefined)).toContain("the PR's head is unknown");
});

// ---- the diff is pinned to the OIDs the metadata read, through a fake `gh` ----

// A fake `gh` that logs each call. `pr view` prints FAKE_GH_VIEW (both OIDs when
// unset) and fails when it is "fail"; `api` and `pr diff` print the same diff.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_DIR/calls.log"
case "$*" in
  "api "*|"pr diff"*)
    printf 'diff --git a/a.ts b/a.ts\\n'
    printf 'index 1111111..2222222 100644\\n'
    printf -- '--- a/a.ts\\n'
    printf '+++ b/a.ts\\n'
    printf '@@ -1 +1,2 @@\\n'
    printf ' one\\n'
    printf '+two\\n' ;;
  "pr view"*)
    [ "$FAKE_GH_VIEW" = fail ] && exit 1
    printf '%s' "\${FAKE_GH_VIEW:-{\\"headRefOid\\": \\"${HEAD}\\", \\"baseRefOid\\": \\"${BASE}\\"}}" ;;
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
  for (const name of ["PATH", "FAKE_GH_DIR", "FAKE_GH_VIEW"]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_VIEW;
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

/** Run getChangedFiles on a fresh source and return the gh call that fetched the diff. */
async function diffCall(options: { repo?: string }): Promise<string> {
  await writeFile(path.join(dir, "calls.log"), "", "utf8");
  const files = await new GitHubPRSource({ prNumber: 7, ...options }).getChangedFiles();
  expect(files.map((file) => file.path)).toEqual(["a.ts"]);
  const calls = (await readFile(path.join(dir, "calls.log"), "utf8")).trim().split("\n");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toStartWith("pr view");
  return calls[1]!;
}

test("getChangedFiles: the diff compares the base and head OIDs the metadata read", async () => {
  expect(await diffCall({ repo: "o/r" })).toBe(
    `api repos/o/r/compare/${BASE}...${HEAD} -H Accept: application/vnd.github.diff`,
  );
  // Without --repo, gh resolves the placeholders from the checkout, as `gh pr` does.
  expect(await diffCall({})).toStartWith(`api repos/{owner}/{repo}/compare/${BASE}...${HEAD} `);
});

test("getChangedFiles: an unknown OID or a failed metadata read falls back to gh pr diff", async () => {
  process.env.FAKE_GH_VIEW = `{"baseRefOid": "${BASE}"}`;
  expect(await diffCall({ repo: "o/r" })).toStartWith("pr diff 7 --repo o/r");
  process.env.FAKE_GH_VIEW = "fail";
  expect(await diffCall({ repo: "o/r" })).toStartWith("pr diff 7 --repo o/r");
});
