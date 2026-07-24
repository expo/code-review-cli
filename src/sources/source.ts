import type { DiffEntry, ReviewMetadata } from "../core/schema.js";

/**
 * A Source is where the diff comes from. CI and local mode differ only in which
 * Source (and Reporter) is wired into the otherwise-identical review core.
 */
export interface ReviewSource {
  getMetadata(): Promise<ReviewMetadata>;
  /** Changed files as path + patch text per file. */
  getChangedFiles(): Promise<DiffEntry[]>;
  /**
   * Optionally materialize the exact tree the review should READ from and return its
   * directory + a cleanup. The review core chdirs into it while running the agents
   * and the verifier, so their read/grep tools see the right versions of files.
   *
   * This matters for a GitHub PR: the diff is authoritative from the API, but the
   * agents also read surrounding source and the verifier re-reads cited files — and
   * those must be the PR-HEAD versions, not whatever happens to be checked out.
   * Return `null` (or omit the method) to just review the current working directory.
   */
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
export function memoizeSource(source: ReviewSource): ReviewSource & { dispose(): Promise<void> } {
  let metadataPromise: Promise<ReviewMetadata> | undefined;
  let changedPromise: Promise<DiffEntry[]> | undefined;
  let readRootPromise: Promise<PreparedReadRoot | null> | undefined;
  let realHandle: PreparedReadRoot | null = null;

  return {
    getMetadata: () => (metadataPromise ??= source.getMetadata()),
    getChangedFiles: () => (changedPromise ??= source.getChangedFiles()),
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
