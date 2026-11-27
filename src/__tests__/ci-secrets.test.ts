import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

import {
  assertSecretsReachable,
  CI_ACCESS_SECRET,
  CI_REFRESH_SECRET,
  ciSecretWrites,
  oauthPairFromStore,
  parseRepoSlug,
  writeSecrets,
} from "../core/ci-secrets.js";
import { resetTrustedToolCache } from "../core/exec.js";

// Records each call as "argv | stdin", so a test can prove where a token went.
const FAKE_GH = `#!/bin/sh
case "$*" in
  "api repos/"*"/actions/secrets/public-key")
    case "$*" in *"$FAKE_GH_UNREACHABLE"*) [ -n "$FAKE_GH_UNREACHABLE" ] && { echo "HTTP 404: Not Found" >&2; exit 1; } ;; esac
    printf '%s | \\n' "$*" >> "$FAKE_GH_DIR/calls.log"
    printf '{"key_id":"k"}' ;;
  "secret set "*)
    value=$(cat)
    case "$*" in *"$FAKE_GH_FAIL_WRITE"*) [ -n "$FAKE_GH_FAIL_WRITE" ] && { echo "HTTP 403: Resource not accessible" >&2; exit 1; } ;; esac
    printf '%s | %s\\n' "$*" "$value" >> "$FAKE_GH_DIR/calls.log" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

const PAIR = { access: "eyJ.ACCESS-TOKEN.sig", refresh: "REFRESH-TOKEN" };
const REPOS = { store: "expo/code-review-sessions", targets: ["expo/expo"] };

let dir = "";
const saved: Record<string, string | undefined> = {};

async function calls(): Promise<string[]> {
  return (await readFile(path.join(dir, "calls.log"), "utf8")).split("\n").filter(Boolean);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ecr-ci-secrets-"));
  await writeFile(path.join(dir, "gh"), FAKE_GH, "utf8");
  await chmod(path.join(dir, "gh"), 0o755);
  await writeFile(path.join(dir, "calls.log"), "", "utf8");
  for (const name of ["PATH", "FAKE_GH_DIR", "FAKE_GH_UNREACHABLE", "FAKE_GH_FAIL_WRITE"]) {
    saved[name] = process.env[name];
  }
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;
  process.env.FAKE_GH_DIR = dir;
  delete process.env.FAKE_GH_UNREACHABLE;
  delete process.env.FAKE_GH_FAIL_WRITE;
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

test("a repo slug is owner/repo and nothing that gh could read as a flag", () => {
  expect(parseRepoSlug("expo/expo")).toBe("expo/expo");
  expect(parseRepoSlug("my-org/repo.name_2")).toBe("my-org/repo.name_2");
  for (const bad of ["expo", "expo/", "/expo", "a/b/c", "--repo/x", "a b/c", ""]) {
    expect(() => parseRepoSlug(bad)).toThrow(/<owner>\/<repo>/);
  }
});

test("the token pair needs both halves of an oauth entry", () => {
  expect(oauthPairFromStore({ xai: { type: "oauth", ...PAIR } }, "xai")).toEqual(PAIR);
  expect(oauthPairFromStore({ xai: { type: "oauth", access: PAIR.access } }, "xai")).toBeNull();
  expect(oauthPairFromStore({ xai: { type: "oauth", refresh: PAIR.refresh } }, "xai")).toBeNull();
  expect(oauthPairFromStore({ xai: { type: "api", ...PAIR } }, "xai")).toBeNull();
  expect(oauthPairFromStore({ openai: { type: "oauth", ...PAIR } }, "xai")).toBeNull();
});

test("the refresh token is written first, and only to the store repo", () => {
  expect(ciSecretWrites(PAIR, REPOS)).toEqual([
    { name: CI_REFRESH_SECRET, repo: "expo/code-review-sessions", value: PAIR.refresh },
    { name: CI_ACCESS_SECRET, repo: "expo/code-review-sessions", value: PAIR.access },
    { name: CI_ACCESS_SECRET, repo: "expo/expo", value: PAIR.access },
  ]);
  // A target that repeats, or that is the store, gets one write.
  const repeated = ciSecretWrites(PAIR, { store: "a/s", targets: ["a/t", "a/s", "a/t"] });
  expect(repeated.map((write) => `${write.name}@${write.repo}`)).toEqual([
    `${CI_REFRESH_SECRET}@a/s`,
    `${CI_ACCESS_SECRET}@a/s`,
    `${CI_ACCESS_SECRET}@a/t`,
  ]);
});

test("each secret value goes to gh through stdin, never on the command line", async () => {
  await writeSecrets(ciSecretWrites(PAIR, REPOS));
  expect(await calls()).toEqual([
    `secret set ${CI_REFRESH_SECRET} --repo expo/code-review-sessions | ${PAIR.refresh}`,
    `secret set ${CI_ACCESS_SECRET} --repo expo/code-review-sessions | ${PAIR.access}`,
    `secret set ${CI_ACCESS_SECRET} --repo expo/expo | ${PAIR.access}`,
  ]);
});

test("a failed write stops the rest and names what is already saved, with no token", async () => {
  process.env.FAKE_GH_FAIL_WRITE = "--repo expo/expo";
  const error = await writeSecrets(ciSecretWrites(PAIR, REPOS)).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(`could not write ${CI_ACCESS_SECRET} to expo/expo`);
  expect(message).toContain("HTTP 403");
  expect(message).toContain(`${CI_REFRESH_SECRET} in expo/code-review-sessions`);
  expect(message).not.toContain(PAIR.access);
  expect(message).not.toContain(PAIR.refresh);
  expect(await calls()).toHaveLength(2);
});

test("an unreachable repo fails before any login or write", async () => {
  await assertSecretsReachable(["expo/code-review-sessions", "expo/expo", "expo/expo"]);
  expect(await calls()).toEqual([
    "api repos/expo/code-review-sessions/actions/secrets/public-key | ",
    "api repos/expo/expo/actions/secrets/public-key | ",
  ]);

  process.env.FAKE_GH_UNREACHABLE = "repos/expo/expo/";
  await expect(assertSecretsReachable(["expo/code-review-sessions", "expo/expo"])).rejects.toThrow(
    /cannot reach the Actions secrets of expo\/expo \(HTTP 404: Not Found\).*Nothing was changed/s,
  );
});
