import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RoutingManifestSchema } from "../config/schema.js";
import {
  loadRoutingManifest,
  resolveScopes,
  scopedCommentTag,
  formatOwnerTable,
} from "../config/routing.js";
import { appendScopeEntry } from "../commands/init.js";
import { stripJsonComments, stripTrailingCommas } from "../config/load.js";
import { commentMarker } from "../core/render.js";
import { fingerprintFinding, scopedFingerprint } from "../core/schema.js";
import type { Finding } from "../core/schema.js";

const manifest = (scopes: Array<{ name: string; paths: string[]; config: string }>) =>
  RoutingManifestSchema.parse({ scopes });

// ---- schema ----

test("RoutingManifestSchema: applies defaults", () => {
  const m = manifest([{ name: "default", paths: ["**/*"], config: "." }]);
  expect(m.comment).toBe("single");
  expect(m.defaults.enforceAgents).toEqual([]);
  expect(m.defaults.commentTag).toBe("expo-ai-code-reviewer");
});

test("RoutingManifestSchema: rejects empty scopes", () => {
  expect(() => RoutingManifestSchema.parse({ scopes: [] })).toThrow();
});

test("RoutingManifestSchema: rejects a non-kebab scope name", () => {
  expect(() =>
    RoutingManifestSchema.parse({ scopes: [{ name: "Bad_Name", paths: ["**/*"], config: "." }] }),
  ).toThrow();
});

test("RoutingManifestSchema: rejects duplicate scope names", () => {
  expect(() =>
    RoutingManifestSchema.parse({
      scopes: [
        { name: "a", paths: ["x/**"], config: "x" },
        { name: "a", paths: ["y/**"], config: "y" },
      ],
    }),
  ).toThrow(/duplicate scope name: a/);
});

test("RoutingManifestSchema: rejects duplicate config dirs (after normalize)", () => {
  expect(() =>
    RoutingManifestSchema.parse({
      scopes: [
        { name: "a", paths: ["x/**"], config: "server/www" },
        { name: "b", paths: ["y/**"], config: "server/www/" },
      ],
    }),
  ).toThrow(/duplicate scope config dir/);
});

test("RoutingScopeSchema: rejects traversal and absolute config paths", () => {
  for (const config of ["../../outside", "/etc/x", "a/../../b"]) {
    expect(() =>
      RoutingManifestSchema.parse({ scopes: [{ name: "x", paths: ["x/**"], config }] }),
    ).toThrow(/repo-relative/);
  }
});

// ---- loadRoutingManifest ----

test("loadRoutingManifest: returns null when the file is absent (BACKCOMPAT)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-routing-"));
  expect(await loadRoutingManifest(dir)).toBeNull();
});

test("loadRoutingManifest: parses JSONC with comments + trailing commas", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-routing-"));
  await mkdir(path.join(root, ".expo-code-review"), { recursive: true });
  await writeFile(
    path.join(root, ".expo-code-review", "routing.jsonc"),
    `{
      // a comment
      "comment": "per-scope",
      "scopes": [
        { "name": "default", "paths": ["**/*"], "config": "." },
      ],
    }`,
    "utf8",
  );
  const m = await loadRoutingManifest(root);
  expect(m?.comment).toBe("per-scope");
  expect(m?.scopes.length).toBe(1);
});

test("loadRoutingManifest: options.configDir reads routing.jsonc from the override dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-routing-"));
  // The manifest lives ONLY in the override dir, not the default .expo-code-review.
  await mkdir(path.join(root, "custom"), { recursive: true });
  await writeFile(
    path.join(root, "custom", "routing.jsonc"),
    `{ "scopes": [{ "name": "override", "paths": ["**/*"], "config": "." }] }`,
    "utf8",
  );
  const m = await loadRoutingManifest(root, { configDir: "custom" });
  expect(m?.scopes[0]!.name).toBe("override");
  // Without the override, the default dir has no manifest → null (backcompat).
  expect(await loadRoutingManifest(root)).toBeNull();
});

test("loadRoutingManifest: no override resolves identically to the default dir (BACKCOMPAT)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-routing-"));
  await mkdir(path.join(root, ".expo-code-review"), { recursive: true });
  await writeFile(
    path.join(root, ".expo-code-review", "routing.jsonc"),
    `{ "scopes": [{ "name": "d", "paths": ["**/*"], "config": "." }] }`,
    "utf8",
  );
  // Undefined configDir and an explicit-but-empty options object resolve the same
  // default path — the ci-path equivalence for a run with no --config-dir.
  expect((await loadRoutingManifest(root))?.scopes[0]!.name).toBe("d");
  expect((await loadRoutingManifest(root, {}))?.scopes[0]!.name).toBe("d");
});

test("loadRoutingManifest: throws on a malformed manifest (never a silent fallback)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ecr-routing-"));
  await mkdir(path.join(root, ".expo-code-review"), { recursive: true });
  await writeFile(
    path.join(root, ".expo-code-review", "routing.jsonc"),
    `{ "scopes": [] }`,
    "utf8",
  );
  await expect(loadRoutingManifest(root)).rejects.toThrow();
});

// ---- resolveScopes ----

test("resolveScopes: single catch-all takes everything, unmatched empty", () => {
  const m = manifest([{ name: "default", paths: ["**/*"], config: "." }]);
  const r = resolveScopes(m, ["a.ts", "src/b.ts"]);
  expect(r.active.length).toBe(1);
  expect(r.active[0]!.files).toEqual(["a.ts", "src/b.ts"]);
  expect(r.unmatched).toEqual([]);
});

test("resolveScopes: LAST matching scope wins", () => {
  const m = manifest([
    { name: "default", paths: ["**/*"], config: "." },
    { name: "www", paths: ["server/www/**"], config: "server/www" },
  ]);
  const r = resolveScopes(m, ["server/www/app.ts", "other.ts"]);
  expect(r.active.find((s) => s.name === "www")!.files).toEqual(["server/www/app.ts"]);
  expect(r.active.find((s) => s.name === "default")!.files).toEqual(["other.ts"]);
});

test("resolveScopes: reversing manifest order flips the winner", () => {
  const m = manifest([
    { name: "www", paths: ["server/www/**"], config: "server/www" },
    { name: "default", paths: ["**/*"], config: "." },
  ]);
  const r = resolveScopes(m, ["server/www/app.ts"]);
  expect(r.active.find((s) => s.name === "default")!.files).toEqual(["server/www/app.ts"]);
  expect(r.active.some((s) => s.name === "www")).toBe(false);
});

test("resolveScopes: reports overlaps with matched list + winner", () => {
  const m = manifest([
    { name: "default", paths: ["**/*"], config: "." },
    { name: "www", paths: ["server/www/**"], config: "server/www" },
  ]);
  const r = resolveScopes(m, ["server/www/app.ts"]);
  expect(r.overlaps).toEqual([
    { file: "server/www/app.ts", matched: ["default", "www"], winner: "www" },
  ]);
});

test("resolveScopes: no catch-all leaves unmatched files unrouted", () => {
  const m = manifest([{ name: "www", paths: ["server/www/**"], config: "server/www" }]);
  const r = resolveScopes(m, ["README.md"]);
  expect(r.active).toEqual([]);
  expect(r.unmatched).toEqual(["README.md"]);
});

test("resolveScopes: scope with zero files is omitted; active preserves manifest order", () => {
  const m = manifest([
    { name: "a", paths: ["a/**"], config: "a" },
    { name: "b", paths: ["b/**"], config: "b" },
    { name: "c", paths: ["c/**"], config: "c" },
  ]);
  const r = resolveScopes(m, ["c/x.ts", "a/y.ts"]);
  expect(r.active.map((s) => s.name)).toEqual(["a", "c"]);
});

test("resolveScopes: glob dialect — ** crosses /, * does not", () => {
  const m = manifest([
    { name: "deep", paths: ["pkg/**"], config: "pkg" },
    { name: "flat", paths: ["top/*"], config: "top" },
  ]);
  const r = resolveScopes(m, ["pkg/a/b/c.ts", "top/a.ts", "top/nested/b.ts"]);
  expect(r.active.find((s) => s.name === "deep")!.files).toEqual(["pkg/a/b/c.ts"]);
  expect(r.active.find((s) => s.name === "flat")!.files).toEqual(["top/a.ts"]);
  expect(r.unmatched).toEqual(["top/nested/b.ts"]);
});

test("formatOwnerTable: one row per file, capped with a +N more tail", () => {
  const m = manifest([{ name: "default", paths: ["**/*"], config: "." }]);
  const r = resolveScopes(m, ["a.ts", "b.ts", "c.ts"]);
  const lines = formatOwnerTable(r, 2);
  expect(lines.length).toBe(3);
  expect(lines[2]).toContain("1 more");
});

// ---- marker isolation (reviewdog race guard, risk 10) ----

test("scopedCommentTag + marker isolation: root marker is NOT a substring of a scoped marker", () => {
  const root = "expo-ai-code-reviewer";
  const scoped = scopedCommentTag(root, "www");
  expect(scoped).toBe("expo-ai-code-reviewer:www");
  expect(commentMarker(scoped).includes(commentMarker(root))).toBe(false);
  expect(commentMarker(root).includes(commentMarker(scoped))).toBe(false);
});

// ---- appendScopeEntry ----

test("appendScopeEntry: inserts before the closing ] preserving comments", () => {
  const raw = `{
  // keep me
  "scopes": [
    { "name": "default", "paths": ["**/*"], "config": "." }
  ]
}`;
  const out = appendScopeEntry(raw, {
    name: "server-www",
    paths: ["server/www/**"],
    config: "server/www",
  })!;
  expect(out).toContain("// keep me");
  expect(out).toContain('"name": "server-www"');
  // Still valid JSON after stripping comments (comma inserted correctly).
  expect(() => RoutingManifestSchema.parse(JSON.parse(out.replace(/\/\/.*$/gm, "")))).not.toThrow();
});

test("appendScopeEntry: comma lands after the entry, not inside a trailing line comment", () => {
  const raw = `{
  "scopes": [
    { "name": "default", "paths": ["**/*"], "config": "." } // the default scope
  ]
}`;
  const out = appendScopeEntry(raw, {
    name: "server-www",
    paths: ["server/www/**"],
    config: "server/www",
  })!;
  expect(out).toContain('"config": "." }, // the default scope');
  // Still valid JSON after stripping comments (comma NOT swallowed by the comment).
  const stripped = stripTrailingCommas(stripJsonComments(out));
  expect(() => RoutingManifestSchema.parse(JSON.parse(stripped))).not.toThrow();
});

test("appendScopeEntry: handles a trailing comma plus block comment after the last entry", () => {
  const raw = `{
  "scopes": [
    { "name": "default", "paths": ["**/*"], "config": "." }, /* keep */
  ]
}`;
  const out = appendScopeEntry(raw, { name: "www", paths: ["www/**"], config: "www" })!;
  // No double comma; still parses after stripping both comment styles.
  const stripped = stripTrailingCommas(stripJsonComments(out));
  expect(() => RoutingManifestSchema.parse(JSON.parse(stripped))).not.toThrow();
});

test("appendScopeEntry: idempotent on an already-present name", () => {
  const raw = `{ "scopes": [ { "name": "www", "paths": ["www/**"], "config": "www" } ] }`;
  expect(appendScopeEntry(raw, { name: "www", paths: ["www/**"], config: "www" })).toBe(raw);
});

test("appendScopeEntry: returns null when there is no scopes array", () => {
  expect(
    appendScopeEntry(`{ "comment": "single" }`, { name: "x", paths: ["x/**"], config: "x" }),
  ).toBeNull();
});

// ---- scopedFingerprint ----

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "warning",
  category: "quality",
  file: "a.ts",
  line: 1,
  title: "T",
  rationale: "r",
  evidence: "const somethingLongEnough = 1;",
  ...over,
});

test("scopedFingerprint: null scope === fingerprintFinding (BACKCOMPAT carry-over)", () => {
  const f = finding();
  expect(scopedFingerprint(null, f)).toBe(fingerprintFinding(f));
});

test("scopedFingerprint: scoped ids are hex-only, same length, and differ per scope", () => {
  const f = finding();
  const plain = fingerprintFinding(f);
  const a = scopedFingerprint("www", f);
  const b = scopedFingerprint("website", f);
  expect(a).toMatch(/^[a-f0-9]+$/);
  expect(a.length).toBe(plain.length);
  expect(a).not.toBe(plain);
  expect(a).not.toBe(b);
});
