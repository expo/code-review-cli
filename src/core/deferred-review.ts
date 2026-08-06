// @ref LLP 0007#deferred-review-posting [implements] — exact preview artifact, explicit target binding, and stale-head/config refusal
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { LoadedConfig } from "../config/schema.js";
import {
  CoordinatorOutputSchema,
  FeedbackRecordSchema,
  type CoordinatorOutput,
  type FeedbackRecord,
} from "./schema.js";

export const DEFERRED_REVIEW_ARTIFACT_VERSION = 1;
export const DEFERRED_REVIEW_ARTIFACT_MAX_BYTES = 1_000_000;
const READ_CHUNK_BYTES = 65_536;

const RepoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected owner/repo");
const CommitOidSchema = z.string().regex(/^[0-9a-f]{40}$/i, "expected a full commit OID");

/**
 * A postable review produced by one completed local PR review. The review and
 * feedback are the exact verified values that terminal preview rendered; target,
 * head and posting-policy bindings are checked again before any GitHub write.
 */
export const DeferredReviewArtifactSchema = z
  .object({
    version: z.literal(DEFERRED_REVIEW_ARTIFACT_VERSION),
    createdAt: z.string().datetime(),
    repo: RepoSchema,
    pr: z.number().int().positive().safe(),
    headSha: CommitOidSchema,
    configFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
    review: CoordinatorOutputSchema,
    feedback: z.array(FeedbackRecordSchema).optional(),
  })
  .strict();

export type DeferredReviewArtifact = z.infer<typeof DeferredReviewArtifactSchema>;

export interface DeferredReviewInput {
  repo: string;
  pr: number;
  headSha: string;
  review: CoordinatorOutput;
  feedback?: FeedbackRecord[];
}

/** Bind the artifact to the local config fields that affect the posted comment. */
export function reviewPostingConfigFingerprint(config: LoadedConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commentTag: config.commentTag,
        breakGlassMarker: config.breakGlassMarker,
        feedback: config.feedback,
      }),
    )
    .digest("hex");
}

function artifactFilename(repo: string, pr: number): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return `${safeRepo}-pr-${pr}-${randomUUID()}.json`;
}

/**
 * Persist with owner-only permissions and exclusive creation. The random filename
 * avoids overwriting another session's pending review; no credential is stored.
 */
export async function writeDeferredReviewArtifact(
  config: LoadedConfig,
  input: DeferredReviewInput,
): Promise<string> {
  const artifact = DeferredReviewArtifactSchema.parse({
    version: DEFERRED_REVIEW_ARTIFACT_VERSION,
    createdAt: new Date().toISOString(),
    repo: input.repo,
    pr: input.pr,
    headSha: input.headSha,
    configFingerprint: reviewPostingConfigFingerprint(config),
    review: input.review,
    ...(input.feedback ? { feedback: input.feedback } : {}),
  });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > DEFERRED_REVIEW_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `deferred review artifact would be ${serializedBytes} bytes; maximum is ${DEFERRED_REVIEW_ARTIFACT_MAX_BYTES}`,
    );
  }
  const dir = path.join(config.configDir, ".runs", "deferred");
  await mkdir(dir, { recursive: true });
  const artifactPath = path.join(dir, artifactFilename(input.repo, input.pr));
  await writeFile(artifactPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return artifactPath;
}

/** Read once, byte-cap before parsing, then cross the strict schema boundary. */
export async function readDeferredReviewArtifact(
  artifactPath: string,
): Promise<DeferredReviewArtifact> {
  const handle = await open(artifactPath, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > DEFERRED_REVIEW_ARTIFACT_MAX_BYTES) {
        throw new Error(
          `deferred review artifact is over ${DEFERRED_REVIEW_ARTIFACT_MAX_BYTES} bytes`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`deferred review artifact is not valid JSON: ${String(error)}`);
  }
  return DeferredReviewArtifactSchema.parse(parsed);
}

/**
 * Final no-write gate. Every value comes from a separate authority: repo/PR from
 * explicit argv, head from live GitHub, config from the local trusted checkout.
 */
export function assertDeferredReviewCurrent(
  artifact: DeferredReviewArtifact,
  expected: { repo: string; pr: number; headSha: string; configFingerprint: string },
): void {
  if (artifact.repo !== expected.repo || artifact.pr !== expected.pr) {
    throw new Error(
      `artifact targets ${artifact.repo}#${artifact.pr}, not explicitly requested ${expected.repo}#${expected.pr}`,
    );
  }
  if (artifact.headSha !== expected.headSha) {
    throw new Error(
      `PR head changed after preview (${artifact.headSha} → ${expected.headSha}); run a fresh review instead of posting stale findings`,
    );
  }
  if (artifact.configFingerprint !== expected.configFingerprint) {
    throw new Error(
      "local review posting policy changed after preview; run a fresh review before posting",
    );
  }
}
