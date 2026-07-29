import { readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Ambient runtime configuration the OpenCode server (and the Claude-compatible
 * loaders inside it) discovers from its project directory. The review core chdirs
 * into a materialized PR-HEAD worktree before starting the server, so every one
 * of these is attacker-writable in a PR: a plugin or MCP definition is arbitrary
 * code execution in a process holding the model credential and a comment-capable
 * GH_TOKEN; a `.env` can repoint a provider base URL; instruction files inject
 * system-level prompts. OPENCODE_CONFIG_CONTENT (how ECR passes its own config)
 * MERGES with project config rather than replacing it, so deleting these from the
 * throwaway worktree is the only isolation that doesn't depend on OpenCode
 * semantics.
 *
 * Exact-name entries match files or directories at any depth; `.env` is matched
 * as a prefix (`.env`, `.env.local`, …). The PR's CHANGES to these files are
 * still reviewed — their diffs are inlined in the task prompt — but the reviewer
 * can no longer open their full head contents, and a finding citing one will
 * fail verification (a documented tradeoff of the scrub approach).
 */
export const AMBIENT_RUNTIME_CONFIG_NAMES = new Set([
  "opencode.json",
  "opencode.jsonc",
  ".opencode",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude",
  ".mcp.json",
  ".cursor",
  ".cursorrules",
]);

/** Names never descended into (and never scrubbed as a unit — `.git` is the worktree link). */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Whether a directory entry is ambient runtime config that must not reach the model runtime. */
export function isAmbientRuntimeConfig(name: string): boolean {
  return AMBIENT_RUNTIME_CONFIG_NAMES.has(name) || name === ".env" || name.startsWith(".env.");
}

/**
 * Remove ambient runtime config from a THROWAWAY materialized tree, at every
 * depth. Must only ever run on a tree ECR created and will delete (a worktree or
 * extracted archive) — never on the user's checkout. Returns the repo-relative
 * paths removed so callers can log them.
 */
export async function scrubAmbientRuntimeConfig(root: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isAmbientRuntimeConfig(entry.name)) {
        await rm(full, { recursive: true, force: true });
        removed.push(path.relative(root, full));
        continue;
      }
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await walk(full);
      }
    }
  };
  await walk(root);
  return removed.sort();
}

/**
 * Remove symlinks whose fully resolved target lies outside the materialized tree.
 *
 * The model runtime's read tools are path-scoped by the LITERAL path argument
 * (buildClaudeArgs' permission rules, and equally OpenCode's project-root
 * containment), but the fs layer underneath follows symlinks — so a PR-committed
 * link (`docs/notes.md -> ~/.claude/.credentials.json`) passes the in-tree check
 * and reads the out-of-tree target. Git can only materialize regular files,
 * directories, and symlinks, so stripping escaping symlinks here closes the whole
 * class.
 *
 * Fail closed: a link whose target cannot be resolved (broken, or a chain that
 * leaves the tree at any hop) is removed too — the target could come into
 * existence later, and a broken link has no legitimate review value. In-tree
 * links survive (realpath resolves chains, so an in-tree alias of an in-tree
 * file is provably contained). Unlike the config scrub, this walk descends into
 * node_modules (a committed one is attacker content); `.git` stays skipped — in
 * a worktree it is an ECR-created gitdir link, not PR content.
 *
 * Must only ever run on a tree ECR created and will delete. Returns the
 * repo-relative paths removed so callers can log them.
 */
export async function removeEscapingSymlinks(root: string): Promise<string[]> {
  // realpath the boundary itself: tmpdir-based roots are often behind symlinks
  // (macOS /var -> /private/var), and containment must compare resolved paths.
  const boundary = await realpath(root);
  const removed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let contained = false;
        try {
          const target = await realpath(full);
          contained = target === boundary || target.startsWith(boundary + path.sep);
        } catch {
          // Unresolvable link: leave `contained` false (fail closed).
        }
        if (!contained) {
          await rm(full, { force: true });
          // Relative to the RESOLVED boundary — the walk runs there, and the
          // caller's `root` may itself sit behind a symlink (macOS /var).
          removed.push(path.relative(boundary, full));
        }
        // In-tree directory links are kept but never descended: their contents
        // are walked once via the real path, and descending would loop on cycles.
        continue;
      }
      if (entry.isDirectory() && entry.name !== ".git") {
        await walk(full);
      }
    }
  };
  await walk(boundary);
  return removed.sort();
}
