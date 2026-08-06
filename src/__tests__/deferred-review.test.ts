import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { parsePostReviewArgs, publishDeferredReview } from "../commands/post-review.js";
import { parseReviewArgs, validateReviewArgs } from "../commands/review.js";
import type { LoadedConfig } from "../config/schema.js";
import {
  assertDeferredReviewCurrent,
  DEFERRED_REVIEW_ARTIFACT_MAX_BYTES,
  DeferredReviewArtifactSchema,
  readDeferredReviewArtifact,
  reviewPostingConfigFingerprint,
  writeDeferredReviewArtifact,
  type DeferredReviewArtifact,
} from "../core/deferred-review.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-deferred-review-"));
  roots.push(root);
  return root;
}

function config(configDir: string, overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    configDir,
    commentTag: "expo-ai-code-reviewer",
    breakGlassMarker: "/skip-review",
    feedback: {
      mode: "annotate",
      dismiss: "never",
      match: "both",
      protectedCategories: ["security", "secrets"],
      maxAdjudications: 10,
    },
    ...overrides,
  } as LoadedConfig;
}

function artifact(overrides: Partial<DeferredReviewArtifact> = {}): DeferredReviewArtifact {
  return DeferredReviewArtifactSchema.parse({
    version: 1,
    createdAt: "2026-08-06T00:00:00.000Z",
    repo: "expo/expo",
    pr: 48557,
    headSha: "a".repeat(40),
    configFingerprint: "b".repeat(64),
    review: {
      decision: "approve",
      findings: [],
      summary: "No findings.",
      incomplete: [],
      reviewTrace: {
        version: 1,
        trust: "unverified-model-diagnostics",
        agents: { correctness: { checked: ["Traced the changed path."], uncertainties: [] } },
      },
    },
    ...overrides,
  });
}

test("writes and reads an owner-only exact review artifact", async () => {
  const root = await tempRoot();
  const loaded = config(path.join(root, ".expo-code-review"));
  const saved = await writeDeferredReviewArtifact(loaded, {
    repo: "expo/expo",
    pr: 48557,
    headSha: "a".repeat(40),
    review: artifact().review,
  });

  expect(saved).toContain(path.join(".runs", "deferred", "expo-expo-pr-48557-"));
  expect((await stat(saved)).mode & 0o777).toBe(0o600);
  const parsed = await readDeferredReviewArtifact(saved);
  expect(parsed.review).toEqual(artifact().review);
  expect(parsed.configFingerprint).toBe(reviewPostingConfigFingerprint(loaded));
  expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(parsed);
});

test("strictly rejects malformed, oversized, and extended artifacts", async () => {
  const root = await tempRoot();
  const malformed = path.join(root, "malformed.json");
  await writeFile(malformed, "{nope", "utf8");
  await expect(readDeferredReviewArtifact(malformed)).rejects.toThrow("not valid JSON");

  const oversized = path.join(root, "oversized.json");
  await writeFile(oversized, "x".repeat(DEFERRED_REVIEW_ARTIFACT_MAX_BYTES + 1), "utf8");
  await expect(readDeferredReviewArtifact(oversized)).rejects.toThrow("is over");

  expect(() => DeferredReviewArtifactSchema.parse({ ...artifact(), injected: true })).toThrow();
});

test("refuses to create an artifact that its bounded reader could not reopen", async () => {
  const root = await tempRoot();
  const loaded = config(path.join(root, ".expo-code-review"));
  await expect(
    writeDeferredReviewArtifact(loaded, {
      repo: "expo/expo",
      pr: 48557,
      headSha: "a".repeat(40),
      review: artifact({ review: { ...artifact().review, summary: "x".repeat(1_000_000) } }).review,
    }),
  ).rejects.toThrow("would be");
});

test("refuses target, head, and posting-policy drift independently", () => {
  const saved = artifact();
  const expected = {
    repo: saved.repo,
    pr: saved.pr,
    headSha: saved.headSha,
    configFingerprint: saved.configFingerprint,
  };
  expect(() => assertDeferredReviewCurrent(saved, expected)).not.toThrow();
  expect(() => assertDeferredReviewCurrent(saved, { ...expected, repo: "expo/eas-cli" })).toThrow(
    "explicitly requested",
  );
  expect(() =>
    assertDeferredReviewCurrent(saved, { ...expected, headSha: "c".repeat(40) }),
  ).toThrow("head changed");
  expect(() =>
    assertDeferredReviewCurrent(saved, { ...expected, configFingerprint: "d".repeat(64) }),
  ).toThrow("posting policy changed");
});

test("posting config fingerprint covers every comment-policy input", () => {
  const root = "/repo/.expo-code-review";
  const base = config(root);
  const fingerprint = reviewPostingConfigFingerprint(base);
  expect(reviewPostingConfigFingerprint(config(root, { commentTag: "other" }))).not.toBe(
    fingerprint,
  );
  expect(reviewPostingConfigFingerprint(config(root, { breakGlassMarker: "/different" }))).not.toBe(
    fingerprint,
  );
  expect(
    reviewPostingConfigFingerprint(config(root, { feedback: { ...base.feedback, mode: "off" } })),
  ).not.toBe(fingerprint);
});

test("post-review argv requires an explicit artifact, repo, and safe PR", () => {
  expect(
    parsePostReviewArgs(["--artifact", "/tmp/review.json", "--repo", "expo/expo", "--pr", "48557"]),
  ).toEqual({
    artifact: "/tmp/review.json",
    repo: "expo/expo",
    pr: 48557,
    help: false,
  });
  expect(() => parsePostReviewArgs(["--pr", "9007199254740992"])).toThrow("safe integer");
  expect(() => parsePostReviewArgs(["--wat"])).toThrow("Unknown argument");
});

test("save-review is PR-only, explicit-target, and mutually exclusive with immediate post", () => {
  const valid = parseReviewArgs([
    "--repo",
    "expo/expo",
    "--pr",
    "48557",
    "--save-review",
    "--json",
  ]);
  expect(() => validateReviewArgs(valid)).not.toThrow();
  expect(() => validateReviewArgs(parseReviewArgs(["--pr", "48557", "--save-review"]))).toThrow(
    "requires explicit --repo",
  );
  expect(() =>
    validateReviewArgs(
      parseReviewArgs(["--repo", "expo/expo", "--pr", "48557", "--save-review", "--post"]),
    ),
  ).toThrow("mutually exclusive");
  expect(() =>
    validateReviewArgs(
      parseReviewArgs(["--repo", "expo/expo", "--pr", "48557", "--save-review", "--scope", "api"]),
    ),
  ).toThrow("does not support --scope");
});

test("deferred publisher checks break-glass before posting the exact review", async () => {
  const saved = artifact();
  const calls: string[] = [];
  let reportedArgs: unknown[] | undefined;
  const poster = {
    checkBreakGlass: async () => {
      calls.push("break-glass");
      return false;
    },
    report: async (...args: unknown[]) => {
      calls.push("report");
      reportedArgs = args;
    },
  };
  expect(
    await publishDeferredReview(poster, saved, async () => {
      calls.push("final-gate");
    }),
  ).toBe("posted");
  expect(calls).toEqual(["break-glass", "final-gate", "report"]);
  expect(reportedArgs).toEqual([saved.review, saved.feedback]);

  calls.length = 0;
  expect(await publishDeferredReview({ ...poster, checkBreakGlass: async () => true }, saved)).toBe(
    "break-glass",
  );
  expect(calls).toEqual([]);

  await expect(
    publishDeferredReview(
      {
        ...poster,
        checkBreakGlass: async () => {
          throw new Error("GitHub unavailable");
        },
      },
      saved,
    ),
  ).rejects.toThrow("GitHub unavailable");
  expect(calls).toEqual([]);

  await expect(
    publishDeferredReview(poster, saved, async () => {
      throw new Error("head changed");
    }),
  ).rejects.toThrow("head changed");
  expect(calls).toEqual(["break-glass"]);
});
