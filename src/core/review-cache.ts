// @ref LLP 0005#review-result-cache [implements] — automated CI reuses only a complete result whose full review input hashes identically
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { LoadedConfig } from "../config/schema.js";
import { pathInside } from "./exec.js";
import type { CoordinatorOutput, DiffEntry, ReviewMetadata } from "./schema.js";

const packageVersion = (createRequire(import.meta.url)("../../package.json") as { version: string })
  .version;

/**
 * Version the cache-key contract independently of the embedded comment-state shape.
 * Bump this whenever review inputs gain a new source that is not represented below.
 */
const REVIEW_INPUT_HASH_VERSION = 1;

export interface ReviewInputHashOptions {
  files: DiffEntry[];
  config: LoadedConfig;
  metadata: Pick<ReviewMetadata, "title" | "body">;
  /** PR-head tree. Changed-file contents are hashed from here, never the base checkout. */
  readRoot: string;
  agents?: string[];
  route?: boolean;
  contextText?: string;
  /**
   * Deliberately absent: the prior-review context block is NOT part of the key.
   *
   * It is derived from the previous review's own result, so including it would
   * change the hash the moment a first review exists and guarantee a miss on
   * every re-review — disabling the cache exactly where it pays. Excluding it is
   * also the consistent answer: a hit means the diff, files, config and metadata
   * are byte-identical, and reusing that run's conclusions is precisely what the
   * prior-review block would have told the model to reuse. Dismissals and author
   * replies likewise stay out — both are applied after the fact at render time,
   * so they change the comment without needing a fresh review.
   */
}

/** Canonical JSON: object-key order never turns the same input into a cache miss. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Hash every input that can change the code-review result while deliberately
 * excluding checkout-local paths and commit OIDs. A restack changes OIDs; when the
 * scoped changed-file contents, normalized patch, prompts/config and PR prose are
 * byte-identical, that is the cache hit this key is meant to recognize.
 */
function normalizedPatch(patch: string, binary: boolean): string {
  return (
    patch
      .split("\n")
      // Blob ids are volatile across a restack. A binary patch has no textual content
      // to hash, so retain its index line as the only content identity available.
      .filter((line) => binary || !line.startsWith("index "))
      // Unrelated lines landing earlier in the file move hunk coordinates without
      // changing the code under review. Preserve any trailing function heading.
      .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/, "@@ @@$1"))
      .join("\n")
  );
}

async function fileContentIdentity(
  root: string,
  file: DiffEntry,
): Promise<{ kind: string; digest?: string; mode?: number; target?: string }> {
  const abs = path.resolve(root, file.path);
  if (!pathInside(abs, root)) {
    throw new Error(`review cache path escapes the PR tree: ${file.path}`);
  }
  let stat;
  try {
    stat = await lstat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    // Never follow a PR-controlled symlink out of the materialized tree.
    return { kind: "symlink", target: await readlink(abs), mode: stat.mode & 0o777 };
  }
  if (!stat.isFile()) {
    return { kind: "other", mode: stat.mode & 0o777 };
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs)) {
    hash.update(chunk as Buffer);
  }
  return { kind: "file", digest: hash.digest("hex"), mode: stat.mode & 0o777 };
}

export async function reviewInputHash(options: ReviewInputHashOptions): Promise<string> {
  const { configDir: _configDir, ...portableConfig } = options.config;
  const sortedFiles = [...options.files].sort(
    (a, b) => a.path.localeCompare(b.path) || (a.status ?? "").localeCompare(b.status ?? ""),
  );
  const files = [];
  // Sequential reads avoid opening one descriptor per changed file on a very wide PR.
  for (const file of sortedFiles) {
    files.push({
      path: file.path,
      patch: normalizedPatch(file.patch, file.binary === true),
      status: file.status ?? "",
      binary: file.binary === true,
      content: await fileContentIdentity(options.readRoot, file),
    });
  }
  const input = {
    version: REVIEW_INPUT_HASH_VERSION,
    engineVersion: packageVersion,
    files,
    config: portableConfig,
    metadata: options.metadata,
    agents: options.agents ? [...options.agents].sort() : null,
    route: options.route === true,
    contextText: options.contextText ?? null,
  };
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * Whether a run may reuse a cached result at all — the single definition of that
 * policy, shared by the legacy and routed CI paths.
 *
 * It lives here because it was previously written out twice, once per path, and
 * the copies drifted: when the offline index was removed, only the legacy copy
 * dropped its research gate, so every routed repo silently kept running fresh
 * reviews for a reason that no longer existed. Two expressions of one policy is
 * the bug; one function that both paths call is the fix.
 *
 * Each flag means "this run has an input the cache key does not represent":
 * dynamic stack context and model-backed reply adjudication both reach outside
 * the scoped diff, and a maintainer's explicit /review is always a real rerun.
 */
export function reviewCacheAllowed(run: {
  bypassTriggerGate: boolean;
  /** Stack walking is on for this run. */
  stack: boolean;
  /** A feedback seam runs this pass (adjudication), not merely annotation. */
  feedback: boolean;
  /** PR metadata resolved; without it there is nothing stable to key on. */
  hasMetadata: boolean;
}): boolean {
  return !run.bypassTriggerGate && !run.stack && !run.feedback && run.hasMetadata;
}

/** Partial/failed reviews must be retried, never made durable by a cache hit. */
export function reviewCanBeReused(review: CoordinatorOutput): boolean {
  return review.couldNotComplete !== true && review.incomplete.length === 0;
}

/** Exact hash match plus the completeness guard used by every CI comment shape. */
export function reviewMatchesInput(
  review: CoordinatorOutput,
  storedHash: string | undefined,
  currentHash: string,
): boolean {
  return (
    storedHash === currentHash && /^[a-f0-9]{64}$/.test(storedHash) && reviewCanBeReused(review)
  );
}
