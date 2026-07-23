import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../core/exec.js';
import { parseUnifiedDiff } from '../core/diff.js';
import type { DiffEntry, ReviewMetadata } from '../core/schema.js';
import type { PreparedReadRoot, ReviewSource } from './source.js';

export interface GitHubPRSourceOptions {
  prNumber: number;
  /** owner/repo. Optional; gh infers it from the checkout when omitted. */
  repo?: string;
  cwd?: string;
}

/**
 * Pulls PR diff + metadata through the `gh` CLI, which is preinstalled and
 * authenticated on GitHub Actions runners via GH_TOKEN.
 */
export class GitHubPRSource implements ReviewSource {
  constructor(private readonly options: GitHubPRSourceOptions) {}

  private repoArgs(): string[] {
    return this.options.repo ? ['--repo', this.options.repo] : [];
  }

  async getMetadata(): Promise<ReviewMetadata> {
    const { stdout } = await run(
      'gh',
      [
        'pr',
        'view',
        String(this.options.prNumber),
        ...this.repoArgs(),
        '--json',
        'title,body,baseRefName,headRefName',
      ],
      { cwd: this.options.cwd }
    );
    const parsed = JSON.parse(stdout) as {
      title?: string;
      body?: string;
      baseRefName?: string;
      headRefName?: string;
    };
    return {
      title: parsed.title ?? '',
      body: parsed.body ?? '',
      baseRef: parsed.baseRefName ?? '',
      headRef: parsed.headRefName ?? '',
    };
  }

  async getChangedFiles(): Promise<DiffEntry[]> {
    const { stdout } = await run(
      'gh',
      ['pr', 'diff', String(this.options.prNumber), ...this.repoArgs()],
      { cwd: this.options.cwd }
    );
    return parseUnifiedDiff(stdout);
  }

  /**
   * Check the PR HEAD out into a throwaway git worktree so the agents and verifier
   * read the PR's versions of files (not whatever branch happens to be checked out).
   * Fetches the head from the repo's own URL — `refs/pull/<n>/head`, which the base
   * repo hosts even for fork PRs — so it's always the correct PR, independent of the
   * local `origin`. Fails SOFT: any problem (not a git repo, fetch/worktree error)
   * returns null, and the review falls back to reading the current checkout.
   */
  async prepareReadRootAsync(): Promise<PreparedReadRoot | null> {
    const cwd = this.options.cwd;
    if (!this.options.repo) {
      // Without an explicit owner/repo we can't build the fetch URL safely.
      return null;
    }
    const url = `https://github.com/${this.options.repo}.git`;
    const ref = `refs/pull/${this.options.prNumber}/head`;
    let parent: string | undefined;
    try {
      await run('git', ['fetch', '--no-tags', '--depth=1', url, ref], { cwd });
      parent = await mkdtemp(path.join(tmpdir(), 'ecr-prhead-'));
      const dir = path.join(parent, 'head'); // must not pre-exist for `worktree add`
      await run('git', ['worktree', 'add', '--detach', dir, 'FETCH_HEAD'], { cwd });
      const removeParent = parent;
      return {
        dir,
        cleanup: async () => {
          try {
            await run('git', ['worktree', 'remove', '--force', dir], { cwd });
          } catch {
            // best effort — fall through to removing the temp dir
          }
          await rm(removeParent, { recursive: true, force: true });
        },
      };
    } catch {
      if (parent) {
        await rm(parent, { recursive: true, force: true }).catch(() => {});
      }
      return null;
    }
  }
}
