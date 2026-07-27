import { readdir, rm } from "node:fs/promises";
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
