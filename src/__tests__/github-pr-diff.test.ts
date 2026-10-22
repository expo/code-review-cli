import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import { resetTrustedToolCache } from "../core/exec.js";
import type { LinkContext } from "../core/render.js";
import { GitHubReporter } from "../reporters/github.js";
import { GitHubPRSource } from "../sources/github-pr.js";

// A fake `gh` that answers `pr diff` the way gh does when the environment forces
// color (CLICOLOR_FORCE or GH_FORCE_TTY): escape codes around every line, even into
// a pipe, unless the call passes `--color never`.
const FAKE_GH = `#!/bin/sh
case "$*" in
  "pr diff"*)
    case " $* " in
      *" --color never "*) on=""; off="" ;;
      *) on=$(printf '\\033[1;37m'); off=$(printf '\\033[m') ;;
    esac
    printf '%sdiff --git a/a.ts b/a.ts%s\\n' "$on" "$off"
    printf '%sindex 1111111..2222222 100644%s\\n' "$on" "$off"
    printf '%s--- a/a.ts%s\\n' "$on" "$off"
    printf '%s+++ b/a.ts%s\\n' "$on" "$off"
    printf '%s@@ -1 +1,2 @@%s\\n' "$on" "$off"
    printf ' one\\n'
    printf '%s+two%s\\n' "$on" "$off" ;;
  "pr view"*) printf '{"baseRefOid": "0123456789abcdef0123456789abcdef01234567"}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

let dir = "";
let savedPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ecr-gh-pr-diff-"));
  await writeFile(path.join(dir, "gh"), FAKE_GH, "utf8");
  await chmod(path.join(dir, "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
  resetTrustedToolCache();
});

afterEach(async () => {
  process.env.PATH = savedPath;
  resetTrustedToolCache();
  await rm(dir, { recursive: true, force: true });
});

test("GitHubPRSource: the PR diff parses when the environment forces color", async () => {
  const files = await new GitHubPRSource({ prNumber: 7, repo: "o/r" }).getChangedFiles();
  expect(files.map((file) => [file.status, file.path])).toEqual([["M", "a.ts"]]);
  expect(files[0]!.patch).toContain("+two");
});

test("GitHubReporter: the link context's diff lines parse when the environment forces color", async () => {
  const reporter = new GitHubReporter({ prNumber: 7, repo: "o/r", commentTag: "t" });
  // linkContextAsync is private; the test drives it directly so only the two gh
  // calls it makes are involved.
  const link = await (
    reporter as unknown as { linkContextAsync: () => Promise<LinkContext> }
  ).linkContextAsync();
  expect([...(link.diffLines?.get("a.ts") ?? [])]).toEqual([1, 2]);
});
