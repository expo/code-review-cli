import type { DiffEntry, ReviewMetadata } from '../core/schema.js';

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
