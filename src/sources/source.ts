// @ref LLP 0008#the-reviewsource-contract — three-valued prepareReadRootAsync (handle/null/throw); memoizeSource shares one materialization across scopes
import type { DiffEntry, ReviewMetadata } from "../core/schema.js";

/**
 * The paths-only manifest of the OPEN pull requests stacked on top of this PR
 * (they branch off its head). Fetched by a source, injected into the coordinator
 * so an absence-style finding a later PR already addresses can be requalified.
 * Everything in it is PR-author-controlled, so it is treated as untrusted data.
 */
// @ref LLP 0010#the-upstack-manifest [implements] — paths-only, author-controlled, fetched once per run
export interface StackManifest {
  upstackPRs: Array<{ number: number; title: string; authorLogin: string; files: string[] }>;
  /** A per-PR file list hit its cap (maxFilesPerPr) — the manifest is a subset. */
  truncated: boolean;
}

/** Bounds + gates for the upward stack walk. Resolved in the command layer from the
 * trusted-base stack config; never head-controlled. Presence of this option (not a
 * boolean) is what turns the walk on. */
// @ref LLP 0010#bounded-guarded-upward-walk [constrained-by] — every field is a hard bound the walk must never exceed
export interface StackWalkOptions {
  maxDepth: number;
  maxPrs: number;
  maxFilesPerPr: number;
  requireSameAuthor: boolean;
}

/** Pick the walk bounds out of a resolved stack config (drops enable/v2 fields). */
export function stackWalkFromConfig(stack: StackWalkOptions): StackWalkOptions {
  return {
    maxDepth: stack.maxDepth,
    maxPrs: stack.maxPrs,
    maxFilesPerPr: stack.maxFilesPerPr,
    requireSameAuthor: stack.requireSameAuthor,
  };
}

/**
 * A Source is where the diff comes from. CI and local mode differ only in which
 * Source (and Reporter) is wired into the otherwise-identical review core.
 */
export interface ReviewSource {
  getMetadata(): Promise<ReviewMetadata>;
  /** Changed files as path + patch text per file. */
  getChangedFiles(): Promise<DiffEntry[]>;
  /**
   * Optionally walk the OPEN PRs stacked on top of this one and return a paths-only
   * manifest. Any error, rate limit, non-stack PR, or empty result returns `null`
   * (fail-open — a broken walk never blocks or changes a review). Omitted entirely
   * by sources with no concept of a stack (LocalGitSource) → a structural no-op.
   */
  // @ref LLP 0010#the-upstack-manifest [constrained-by] — fail-open: any failure returns null, never throws, so a broken walk leaves the review exactly as if the feature were off
  getStackContextAsync?(options: StackWalkOptions): Promise<StackManifest | null>;
  /**
   * Optionally materialize the exact tree the review should READ from and return its
   * directory + a cleanup. The review core chdirs into it while running the agents
   * and the verifier, so their read/grep tools see the right versions of files.
   *
   * This matters for a GitHub PR: the diff is authoritative from the API, but the
   * agents also read surrounding source and the verifier re-reads cited files — and
   * those must be the PR-HEAD versions, not whatever happens to be checked out.
   * Return `null` (or omit the method) to just review the current working directory.
   *
   * Contract: `null` means "no tree to materialize" (a deliberate, safe
   * fall-through to the current checkout). A materialization FAILURE throws —
   * the review core fails closed on it in CI mode and falls back softly only in
   * local mode, where the user's own checkout is an acceptable read root.
   */
  // @ref LLP 0008#the-reviewsource-contract [constrained-by] — null and throw are not interchangeable: null is safe fall-through, throw is real failure the caller must interpret per mode
  prepareReadRootAsync?(): Promise<PreparedReadRoot | null>;
}

export interface PreparedReadRoot {
  /** Directory the review should read from (chdir target). */
  dir: string;
  /** Remove the materialized tree; always called in a finally. */
  cleanup: () => Promise<void>;
}

/**
 * Wrap a source so getMetadata/getChangedFiles/prepareReadRootAsync each run once
 * and are shared across N sequential runReview calls (one `gh pr diff`, one
 * PR-head worktree for the whole fan-out — rate-limit hygiene, risk 6). The wrapped
 * prepareReadRootAsync hands each run a handle whose cleanup() is a no-op; the real
 * cleanup is deferred to dispose(), which must be called once after the last scope.
 */
// @ref LLP 0008#the-reviewsource-contract [implements] — one fetch/worktree shared across N scope runs; dispose() must run once, after the last scope, not per call
export function memoizeSource(source: ReviewSource): ReviewSource & { dispose(): Promise<void> } {
  let metadataPromise: Promise<ReviewMetadata> | undefined;
  let changedPromise: Promise<DiffEntry[]> | undefined;
  let readRootPromise: Promise<PreparedReadRoot | null> | undefined;
  let stackPromise: Promise<StackManifest | null> | undefined;
  let realHandle: PreparedReadRoot | null = null;

  const stackFn = source.getStackContextAsync;
  return {
    getMetadata: () => (metadataPromise ??= source.getMetadata()),
    getChangedFiles: () => (changedPromise ??= source.getChangedFiles()),
    // One PR has one stack: fetch it once and share it across every scope's run
    // (like getMetadata). Only exposed when the wrapped source can walk a stack, so
    // an optional-chained call on a stack-less source stays a structural no-op.
    ...(stackFn
      ? {
          getStackContextAsync: (options: StackWalkOptions) =>
            (stackPromise ??= stackFn.call(source, options)),
        }
      : {}),
    prepareReadRootAsync: async () => {
      readRootPromise ??= source.prepareReadRootAsync
        ? source.prepareReadRootAsync()
        : Promise.resolve(null);
      realHandle = await readRootPromise;
      if (!realHandle) {
        return null;
      }
      // No-op cleanup per run; the real teardown happens once in dispose().
      return { dir: realHandle.dir, cleanup: async () => {} };
    },
    dispose: async () => {
      if (realHandle) {
        const handle = realHandle;
        realHandle = null;
        await handle.cleanup();
      }
    },
  };
}
