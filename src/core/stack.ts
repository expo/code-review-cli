// @ref LLP 0010#grounding-and-the-decision [implements] — one normalization shared by grounding membership and v2 confirmation dedupe, so both agree on what "the same upstack path" means
import type { StackManifest } from "../sources/source.js";

/**
 * Repo-root-relative normalization for exact manifest membership: strip a leading
 * `./` or `/`, trim. No substrings, no basenames — the unsound-matching critique
 * (`a.ts` must not match `data.ts`). Grounding and confirmation both key on this.
 */
export function normalizeManifestPath(file: string): string {
  return file
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

/** Membership/dedupe key for a cited `(prNumber, file)`. */
export function manifestKey(prNumber: number, file: string): string {
  return `${prNumber} ${normalizeManifestPath(file)}`;
}

/** The set of every `(prNumber, file)` the manifest actually lists. */
export function buildManifestMembership(manifest: StackManifest): Set<string> {
  const members = new Set<string>();
  for (const pr of manifest.upstackPRs) {
    for (const file of pr.files) {
      members.add(manifestKey(pr.number, file));
    }
  }
  return members;
}
