// @ref LLP 0006#routing-manifest — routing.jsonc parsing, scope resolution (last-match-wins), overlaps/unmatched
// @ref LLP 0006#loading-and-the-config-dir-escape-hatch — routing.jsonc travels with config.jsonc via resolveConfigDir
// @ref LLP 0006#budgets-and-chunking-defaults — per-scope budget split (scopePassesBudgetMs)
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { RoutingManifestSchema } from "./schema.js";
import type { RoutingManifest } from "./schema.js";
import { resolveConfigDir, stripJsonComments, stripTrailingCommas } from "./load.js";
import { matchesIgnore } from "../core/noise.js";

export const ROUTING_FILENAME = "routing.jsonc";

/**
 * Parse the routing manifest. It lives in the SAME resolved root config dir as
 * config.jsonc (`resolveConfigDir` — the `--config-dir`/`ECR_CONFIG_DIR` escape
 * hatch): the override designates an alternate ROOT config dir, so config.jsonc
 * and routing.jsonc always travel together and never split across the override
 * and the default tree. With no override the dir is `<root>/.expo-code-review`,
 * byte-identical to the pre-escape-hatch path. Absent file => null (backcompat).
 * Scope `config` paths stay repo-root-relative (see `loadScopeConfig`): an
 * override relocates only the ROOT artifacts, never the scopes' own subtrees.
 */
// @ref LLP 0006#loading-and-the-config-dir-escape-hatch [implements] — travels with config.jsonc; a real bug once let them split
export async function loadRoutingManifest(
  root: string,
  options: { configDir?: string } = {},
): Promise<RoutingManifest | null> {
  const manifestPath = path.join(resolveConfigDir(root, options.configDir), ROUTING_FILENAME);
  if (!existsSync(manifestPath)) {
    return null;
  }
  const raw = await readFile(manifestPath, "utf8");
  // Let schema/JSON errors throw — a malformed manifest must be a loud error,
  // never a silent fallback to single-scope behavior.
  return RoutingManifestSchema.parse(JSON.parse(stripTrailingCommas(stripJsonComments(raw))));
}

export interface ResolvedScope {
  name: string;
  /** Repo-relative dir (scope.config), NOT the .expo-code-review path itself. */
  configDir: string;
  /** Changed files assigned to this scope (repo-relative, diff order preserved). */
  files: string[];
}

export interface ScopeResolution {
  /** Scopes with >=1 matched file, in manifest order. */
  active: ResolvedScope[];
  /** Changed files matching NO scope (coverage gap; empty when a '**\/*' catch-all exists). */
  unmatched: string[];
  /** Files that matched >1 scope, with the last-match winner (doctor/CI-log warnings). */
  overlaps: Array<{ file: string; matched: string[]; winner: string }>;
}

// The repo's minimal glob translates `**` to `.*`, so a leading double-star + slash
// requires at least one slash in the path — which would make the documented catch-all
// silently miss root-level files (README.md, package.json). To give the double-star +
// slash its conventional "zero or more directories" meaning, we also test the variant
// with each such prefix removed, so the catch-all matches both `a.ts` and `src/b.ts`.
// @ref LLP 0006#routing-manifest [constrained-by] — workaround for matchesIgnore's **-needs-a-slash limitation (LLP 0004 dialect)
function patternVariants(pattern: string): string[] {
  const collapsed = pattern.replace(/\*\*\//g, "");
  return collapsed !== pattern && collapsed.length > 0 ? [pattern, collapsed] : [pattern];
}

/** Does any of the scope's globs match this file? */
function scopeMatches(paths: string[], file: string): boolean {
  return paths.some((pattern) =>
    patternVariants(pattern).some((variant) => matchesIgnore(file, variant)),
  );
}

/**
 * Assign each changed file to exactly one scope: test the file against every
 * scope's paths in ARRAY ORDER; the LAST matching scope wins. Glob matching via
 * matchesIgnore (supports ** across / and * within a segment — the manifest
 * documents this dialect). Deterministic, no filesystem access.
 */
// @ref LLP 0006#routing-manifest [implements] — last-match-wins (CODEOWNERS discipline); each file lands in exactly one scope
export function resolveScopes(manifest: RoutingManifest, changedFiles: string[]): ScopeResolution {
  const buckets = new Map<string, string[]>();
  const unmatched: string[] = [];
  const overlaps: ScopeResolution["overlaps"] = [];

  for (const file of changedFiles) {
    const matched: string[] = [];
    for (const scope of manifest.scopes) {
      if (scopeMatches(scope.paths, file)) {
        matched.push(scope.name);
      }
    }
    if (matched.length === 0) {
      unmatched.push(file);
      continue;
    }
    const winner = matched[matched.length - 1]!;
    (buckets.get(winner) ?? buckets.set(winner, []).get(winner)!).push(file);
    if (matched.length > 1) {
      overlaps.push({ file, matched, winner });
    }
  }

  const active: ResolvedScope[] = [];
  for (const scope of manifest.scopes) {
    const files = buckets.get(scope.name);
    if (files && files.length > 0) {
      active.push({ name: scope.name, configDir: scope.config, files });
    }
  }

  return { active, unmatched, overlaps };
}

/** Scoped comment tag: `${defaults.commentTag}:${scope.name}` (distinct full marker). */
export function scopedCommentTag(rootTag: string, scopeName: string): string {
  return `${rootTag}:${scopeName}`;
}

/** The per-scope passes budget derived from the manifest's total (see below). */
export interface ScopeBudget {
  /** Per-scope wall-clock ceiling for review passes, in ms. */
  perScopeMs: number;
  /** True when the `min` floor forced `activeCount * perScopeMs` past `totalMs`
   * — i.e. the scopes will run longer than the total budget. */
  overshoot: boolean;
}

/**
 * Divide the total passes budget across N active scopes, which run SEQUENTIALLY
 * in one `ecr ci` process. Even split = `floor(total / active)`, clamped up to
 * `min` so a scope always gets a workable window. When that clamp wins (the even
 * split fell below `min`), the floor is kept — a scope below `min` isn't worth
 * starting — and `overshoot` flags that the run will exceed the total budget so
 * the caller can warn. Pure so the math is unit-testable.
 */
// @ref LLP 0006#budgets-and-chunking-defaults [implements] — floor(total/active) clamped to a 5-min floor; overshoot flags the clamp
export function scopePassesBudgetMs(
  totalMs: number,
  minMs: number,
  activeCount: number,
): ScopeBudget {
  const count = Math.max(1, activeCount);
  const evenSplit = Math.floor(totalMs / count);
  const perScopeMs = Math.max(minMs, evenSplit);
  return { perScopeMs, overshoot: count * perScopeMs > totalMs };
}

/**
 * Owner table for doctor/CI logs (graft 4): one row per file —
 * `file  →  winning scope (also matched: a, b)`. Returns printable lines,
 * capped at `limit` rows with a "+N more" tail.
 */
export function formatOwnerTable(resolution: ScopeResolution, limit = 40): string[] {
  const rows: Array<{ file: string; scope: string; also: string[] }> = [];
  const overlapByFile = new Map(resolution.overlaps.map((o) => [o.file, o]));
  for (const scope of resolution.active) {
    for (const file of scope.files) {
      const overlap = overlapByFile.get(file);
      const also = overlap ? overlap.matched.filter((name) => name !== scope.name) : [];
      rows.push({ file, scope: scope.name, also });
    }
  }
  for (const file of resolution.unmatched) {
    rows.push({ file, scope: "(none)", also: [] });
  }

  const lines: string[] = [];
  for (const row of rows.slice(0, limit)) {
    const suffix = row.also.length > 0 ? `  (also matched: ${row.also.join(", ")})` : "";
    lines.push(`  ${row.file}  →  ${row.scope}${suffix}`);
  }
  if (rows.length > limit) {
    lines.push(`  …and ${rows.length - limit} more`);
  }
  return lines;
}
