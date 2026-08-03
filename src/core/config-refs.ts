// @ref LLP 0012#the-ref-grammar — one grammar for every code citation in a review setup
// @ref LLP 0012#no-line-numbers-symbol-anchors-instead — targets are files, dirs, globs, symbols; never line numbers
// @ref LLP 0012#unannotated-citations-are-broken-refs — a path-like backtick token that is not a ref fails the check
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIRNAME, stripJsonComments, stripTrailingCommas } from "../config/load.js";
import { ROUTING_FILENAME } from "../config/routing.js";
import { git, pathInside } from "./exec.js";
import { matchesIgnore } from "./noise.js";

/**
 * Built by concatenation so this module's own regexes and doc comments are not
 * themselves collected as refs by a scanner (the repo's `ref-check` does the same).
 */
const REF_MARK = "@" + "ref";
const IGNORE_MARK = REF_MARK + "-ignore";

/** `@ref <target> [relation] — gloss` inside a `//`-style comment. */
const LINE_REF_RE = new RegExp(String.raw`${REF_MARK}\s+(.+)`);
/** `<!-- @ref <target> — gloss -->`, possibly spanning lines. */
const MD_REF_RE = new RegExp(String.raw`<!--\s*${REF_MARK}\s+([\s\S]+?)-->`, "g");
const IGNORE_RE = new RegExp(String.raw`${IGNORE_MARK}\s+(.+)`);

/** LLP-corpus targets (`LLP 0004#anchor`) belong to the engine repo, not an adopting one. */
const LLP_TARGET_RE = /^LLP\s+\d{1,4}(?:#\S+)?$/;
const URL_RE = /^https?:\/\/\S+$/;
/** `<path>`, `<agent-id>`: documenting the grammar, not citing a file. */
const PLACEHOLDER_RE = /^[<`]/;
const GLOB_PREFIX = "glob:";

/** A citation that pins a line (`src/a.ts:42`, `src/a.ts:42-51`) — always refused. */
const LINE_CITATION_RE = /^(.+?):(\d+)(?:-\d+)?$/;

/**
 * Extensions that make a backticked token a *code citation* rather than prose.
 * Deliberately an allowlist: `openai/gpt-5.5` and `label:<agent>` must not read as
 * paths, while `session.ts` and `.github/workflows/**` must.
 */
const CITATION_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".lock",
  ".md",
  ".mjs",
  ".mts",
  ".php",
  ".prisma",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml",
  ".zsh",
]);

/** Files inside a review-setup dir that are prompts or config (everything else is skipped). */
const SCANNED_EXTENSIONS = new Set([".md", ".markdown", ".json", ".jsonc", ".txt"]);

export type RefProblemKind =
  | "broken-ref"
  | "line-number-ref"
  | "unannotated-citation"
  | "structural";

export interface RefProblem {
  /** Repo-relative file the problem was found in. */
  file: string;
  line: number;
  kind: RefProblemKind;
  /** One sentence, imperative where a fix is obvious. */
  problem: string;
}

export interface ParsedRef {
  file: string;
  line: number;
  /** The target as written, gloss and relation stripped (`src/a.ts#foo`, `glob:**\/*.ts`). */
  target: string;
}

export interface RefCheckReport {
  ok: boolean;
  problems: RefProblem[];
  /** Every resolvable ref found, so callers can tell when a PR touches cited code. */
  refs: ParsedRef[];
  /** Repo-relative review-setup files that were scanned. */
  scannedFiles: string[];
  /** Repo-relative paths (files and dirs) that some ref cites. */
  citedPaths: string[];
}

interface RepoIndex {
  root: string;
  /** Tracked files, repo-relative with `/` separators. Empty when git is unavailable. */
  files: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GitHub-style heading slug: lowercase, spaces to hyphens, drop other punctuation. */
export function slugifyHeading(text: string): string {
  return [...text.replace(/`/g, "").trim().toLowerCase()]
    .map((ch) => (/[a-z0-9\-_]/.test(ch) ? ch : /\s/.test(ch) ? "-" : ""))
    .join("");
}

/** Heading texts outside fenced code blocks. */
function markdownHeadings(text: string): string[] {
  const headings: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    const match = fenced ? null : /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      headings.push(match[1]!);
    }
  }
  return headings;
}

/** Strip the trailing `— gloss` and `[relation]` so only the target remains. */
function refTarget(body: string): string {
  const withoutGloss = body.split(/\s+(?:[—–]|--)(?:\s+|$)/)[0]!.trim();
  const withoutRelation = withoutGloss.replace(/\s*\[[a-z-]+\]\s*$/, "").trim();
  // `LLP 0009#anchor` is ONE target that contains a space; taking the first
  // whitespace-separated token would leave a bare `LLP` and read as a broken path.
  const llp = /^LLP\s+\d{1,4}(?:#\S+)?/.exec(withoutRelation);
  return llp ? llp[0] : (withoutRelation.split(/\s+/)[0] ?? "");
}

/** Line numbers (1-based) that sit inside a fenced code block. */
function fencedLines(text: string): Set<number> {
  const fenced = new Set<number>();
  let open = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith("```")) {
      fenced.add(index + 1); // the fence line itself is never a ref site
      open = !open;
      return;
    }
    if (open) {
      fenced.add(index + 1);
    }
  });
  return fenced;
}

/**
 * Every `@ref` annotation in a setup file, markdown comments included. Fenced code
 * blocks are skipped: an annotation shown inside one is documenting the grammar, and
 * resolving it would make every doc that explains refs fail the check.
 */
export function parseRefAnnotations(text: string, file: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  if (file.endsWith(".md") || file.endsWith(".markdown")) {
    const fenced = fencedLines(text);
    for (const match of text.matchAll(MD_REF_RE)) {
      const line = text.slice(0, match.index).split("\n").length;
      if (fenced.has(line)) {
        continue;
      }
      refs.push({ file, line, target: refTarget(match[1]!) });
    }
    return refs;
  }
  text.split(/\r?\n/).forEach((lineText, index) => {
    const match = LINE_REF_RE.exec(lineText);
    if (match) {
      refs.push({ file, line: index + 1, target: refTarget(match[1]!) });
    }
  });
  return refs;
}

/** Tokens an author declared as prose, not citations (`@ref-ignore knex.raw()`). */
export function parseRefIgnores(text: string): Set<string> {
  const ignored = new Set<string>();
  for (const lineText of text.split(/\r?\n/)) {
    const match = IGNORE_RE.exec(lineText);
    if (!match) {
      continue;
    }
    for (const token of match[1]!.replace(/-->\s*$/, "").split(/[\s,]+/)) {
      const cleaned = token.replace(/^`|`$/g, "").trim();
      if (cleaned) {
        ignored.add(cleaned);
      }
    }
  }
  return ignored;
}

/**
 * Does this backticked token cite code? True for `a/b/c.ts`, `session.ts`,
 * `src/entities/oauth/` and `.github/workflows/**`; false for `ecr ci`,
 * `label:<agent>`, `knex.raw()`, `openai/gpt-5.5` and bare `**`.
 */
export function isCodeCitation(token: string): boolean {
  if (!token || /[\s<>(){}"'|=,;]/.test(token) || token.length > 200) {
    return false;
  }
  const withoutLine = LINE_CITATION_RE.exec(token)?.[1] ?? token;
  if (withoutLine.includes(":")) {
    return false;
  }
  if (withoutLine.endsWith("/")) {
    return withoutLine.replace(/[/*]/g, "").length > 0;
  }
  const base = withoutLine.split("/").pop() ?? "";
  // A wildcard tail inside a path (`.github/workflows/**`) is a citation with no extension.
  if (base.includes("*") && withoutLine.includes("/")) {
    return withoutLine.replace(/[/*]/g, "").length > 0;
  }
  // A bare extension (`.ts`, `.js`) is prose about a suffix, not a file.
  if (CITATION_EXTENSIONS.has(base.toLowerCase())) {
    return false;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0 && !base.startsWith(".")) {
    return false;
  }
  const extension = base.slice(base.lastIndexOf("."));
  return CITATION_EXTENSIONS.has(extension.toLowerCase()) && base.replace(/[*.]/g, "").length > 0;
}

/**
 * The ref an unannotated citation should have become. Abbreviated paths (`.../a/B.kt`),
 * wildcards (`*Policy.ts`) and bare filenames (`session.ts`) become suffix globs, so a
 * prompt keeps its short readable form and still gets checked.
 */
export function suggestedRef(token: string): string {
  const trimmed = token.replace(/^\.\.\.\/?/, "").replace(/^\/+/, "");
  if (token.startsWith("...") || !trimmed.includes("/")) {
    return `${GLOB_PREFIX}**/${trimmed}`;
  }
  return trimmed.includes("*") ? `${GLOB_PREFIX}${trimmed}` : trimmed;
}

/**
 * Every form under which an annotated target can cover a prose citation, so one ref
 * silences the token it is about: `glob:src/commands/*.ts` covers `src/commands/*.ts`,
 * and `src/core/util.ts#errorMessage` covers `src/core/util.ts`.
 */
function coveringForms(target: string): string[] {
  const bare = target.startsWith(GLOB_PREFIX) ? target.slice(GLOB_PREFIX.length) : target;
  const withoutAnchor = splitAnchor(bare)[0];
  return [target, bare, withoutAnchor].flatMap((form) => [
    form,
    form.replace(/\/$/, ""),
    `${form}/`,
  ]);
}

/** The forms a prose citation could have been annotated as. */
function citationForms(token: string): string[] {
  const suggested = suggestedRef(token);
  return [
    token,
    token.replace(/\/$/, ""),
    suggested,
    suggested.startsWith(GLOB_PREFIX) ? suggested.slice(GLOB_PREFIX.length) : suggested,
  ];
}

/**
 * Paths to test when a token has no extension to give it away — `eas-build-worker/terraform`,
 * `general-central/{module,production}`, a bare `finops`. These are only citations if they
 * actually resolve, since `anthropic/claude-opus-5` is shaped exactly the same and is not
 * a path. Returns the candidate paths to probe, or [] when the token cannot be one.
 */
export function pathishCandidates(token: string): string[] {
  if (!token || token.length > 200) {
    return [];
  }
  // Cut a brace list or wildcard tail off FIRST: the part before it is the path to
  // probe, and only that part has to look like one (`a/{b,c}` carries a comma).
  const cut = Math.min(
    ...[token.indexOf("{"), token.indexOf("*")].filter((index) => index >= 0),
    token.length,
  );
  const prefix = token.slice(0, cut).replace(/\/$/, "");
  if (
    !prefix ||
    !/[a-zA-Z]/.test(prefix) ||
    /[\s<>()"'|=,;:]/.test(prefix) ||
    prefix.startsWith("-")
  ) {
    return [];
  }
  return prefix === token ? [token] : [prefix];
}

/** Backticked code citations, outside fenced code blocks, with their line numbers. */
export function findProseCitations(text: string): Array<{ line: number; token: string }> {
  const found: Array<{ line: number; token: string }> = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((lineText, index) => {
    if (lineText.trimStart().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      return;
    }
    for (const match of lineText.matchAll(/`([^`]+)`/g)) {
      found.push({ line: index + 1, token: match[1]! });
    }
  });
  return found;
}

async function pathKind(absolute: string): Promise<"file" | "dir" | "missing"> {
  try {
    const stats = await stat(absolute);
    return stats.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Resolve one ref target against the repo. Returns the problem text, or null when
 * the ref holds. Refs are ALWAYS repo-root-relative — a scope's prompts cite the
 * same paths the reviewer sees in the diff, so there is no per-directory base.
 */
async function resolveTarget(
  target: string,
  index: RepoIndex,
  /** A scope's own subtree, used only to say "did you mean" on a scope-relative path. */
  scopeRoot?: string,
): Promise<string | null> {
  if (!target) {
    return `empty ${REF_MARK} target`;
  }
  if (URL_RE.test(target) || LLP_TARGET_RE.test(target) || PLACEHOLDER_RE.test(target)) {
    // URLs are shape-only (never fetched); LLP numbers belong to the engine's own
    // corpus (`./ref-check`); `<placeholder>` targets are documentation of the syntax.
    return null;
  }
  if (target.startsWith(GLOB_PREFIX)) {
    const pattern = target.slice(GLOB_PREFIX.length);
    if (!pattern) {
      return `empty glob in ${REF_MARK} target`;
    }
    if (index.files.length === 0) {
      return null; // no file list to match against (not a git checkout) — uncheckable
    }
    return index.files.some((file) => matchesIgnore(file, pattern))
      ? null
      : `glob matches no file in the repo: ${pattern}`;
  }
  const lineCitation = LINE_CITATION_RE.exec(target);
  if (lineCitation) {
    return `cites a line number (${target}); refs pin a file, dir, glob, or \`#symbol\` — line numbers rot silently`;
  }

  const [rawPath, anchor] = splitAnchor(target);
  if (path.isAbsolute(rawPath) || rawPath.startsWith("~")) {
    return `absolute path (${rawPath}); refs are repo-root-relative`;
  }
  const absolute = path.resolve(index.root, rawPath);
  if (!pathInside(absolute, index.root)) {
    return `escapes the repository (${rawPath})`;
  }
  const kind = await pathKind(absolute);
  if (kind === "missing") {
    // A scope's prompts naturally say `general-central/module` for what is really
    // `infrastructure/general-central/module`. That is still a broken ref (one base, no
    // ambiguity), but the fix is named instead of left as a puzzle.
    const scoped = scopeRoot ? path.resolve(scopeRoot, rawPath) : null;
    if (scoped && pathInside(scoped, index.root) && (await pathKind(scoped)) !== "missing") {
      const suggestion = path.relative(index.root, scoped).split(path.sep).join("/");
      return `no such path in the repo: ${rawPath} — refs are repo-root-relative; did you mean ${suggestion}?`;
    }
    return `no such path in the repo: ${rawPath}`;
  }
  if (rawPath.endsWith("/") && kind !== "dir") {
    return `${rawPath} is a file, not a directory (drop the trailing slash)`;
  }
  if (!anchor) {
    return null;
  }
  if (kind === "dir") {
    return `${rawPath} is a directory, so \`#${anchor}\` cannot resolve`;
  }
  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch {
    return null; // unreadable (binary, permissions) — uncheckable, never a failure
  }
  if (rawPath.endsWith(".md") || rawPath.endsWith(".markdown")) {
    const slugs = new Set(markdownHeadings(content).map(slugifyHeading));
    return slugs.has(slugifyHeading(anchor)) ? null : `${rawPath} has no heading #${anchor}`;
  }
  return new RegExp(String.raw`\b${escapeRegExp(anchor)}\b`).test(content)
    ? null
    : `${rawPath} no longer contains \`${anchor}\``;
}

/**
 * How a setup file is named in a problem. Normally repo-relative, but in CI the setup
 * is materialized from the trusted base ref OUTSIDE the code tree, where a relative
 * path would read as `../../tmp/…`; there, name it by its position in the setup dir.
 */
function fileLabel(root: string, setupDir: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative.startsWith("..")) {
    return relative;
  }
  return path.join(CONFIG_DIRNAME, path.relative(setupDir, file));
}

function splitAnchor(target: string): [string, string | undefined] {
  const hash = target.indexOf("#");
  return hash === -1 ? [target, undefined] : [target.slice(0, hash), target.slice(hash + 1)];
}

/**
 * The repo's files, repo-relative with `/` separators — what `glob:` targets and scope
 * globs match against. `git ls-files` when possible (fast, and "tracked" is the right
 * notion for reviewable code), else a filesystem walk so the check still works in a
 * plain directory. Empty only for an unreadable root.
 */
async function listRepoFiles(root: string): Promise<string[]> {
  try {
    // Tracked AND untracked-but-not-ignored: a plain path ref resolves with `stat` and
    // therefore sees a file the moment it exists, so a glob must too — otherwise a
    // freshly scaffolded (uncommitted) tree reports globs as matching nothing.
    const tracked = (await git(["ls-files", "--cached", "--others", "--exclude-standard"], root))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (tracked.length > 0) {
      return tracked;
    }
  } catch {
    // not a git checkout — fall through to the walk
  }
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || (entry.name.startsWith(".") && entry.isDirectory())) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        found.push(path.relative(root, child).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  return found.sort();
}

// @ref LLP 0012#what-gets-scanned [implements] — on-disk sweep of every setup dir, .runs/ excluded
/**
 * Every review-setup directory in the repo, found by walking the tree (not the
 * routing manifest): a scope dir the manifest forgot still ships prompts to nobody,
 * and its stale refs are exactly what this check exists to surface.
 */
export async function discoverSetupDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.name === CONFIG_DIRNAME) {
        found.push(child);
        continue; // a setup dir never nests another
      }
      // Other dot dirs are skipped wholesale: `.claude/worktrees/` holds checkouts of
      // this same repo, whose setup dirs would otherwise be swept as if they were scopes.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      await walk(child);
    }
  }
  await walk(root);
  return found.sort();
}

/** Prompt and config files inside a setup dir. Skips `.runs/` and other dot entries. */
async function setupFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(child);
      }
    }
  }
  await walk(dir);
  return found.sort();
}

function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// @ref LLP 0012#structural-refs-need-no-annotation [implements] — ids and scope dirs are refs the config already declares
/**
 * Refs the config declares structurally, so they are checked without an annotation:
 * every `enforceAgents` id must have a root `agents/<id>.md`, every scope must point
 * at a real setup dir, and every scope glob must match at least one tracked file (a
 * glob matching nothing means those prompts review nothing).
 */
async function checkRoutingManifest(
  file: string,
  index: RepoIndex,
  rootAgentIds: Set<string>,
): Promise<RefProblem[]> {
  const problems: RefProblem[] = [];
  const relative = fileLabel(index.root, path.dirname(file), file);
  let parsed: Record<string, unknown> | null;
  try {
    parsed = parseJsonc(await readFile(file, "utf8"));
  } catch {
    return problems;
  }
  if (!parsed) {
    return [
      { file: relative, line: 1, kind: "structural", problem: "could not be parsed as JSONC" },
    ];
  }

  const defaults = (parsed.defaults ?? {}) as Record<string, unknown>;
  const enforced = new Set(stringArray(defaults.enforceAgents));
  const scopes = Array.isArray(parsed.scopes) ? parsed.scopes : [];
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") {
      continue;
    }
    const entry = scope as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : "(unnamed)";
    for (const id of stringArray(entry.enforceAgents)) {
      enforced.add(id);
    }
    const configDir = typeof entry.config === "string" ? entry.config : null;
    if (configDir) {
      const setupDir = path.resolve(index.root, configDir, CONFIG_DIRNAME);
      if (!pathInside(setupDir, index.root)) {
        problems.push({
          file: relative,
          line: 1,
          kind: "structural",
          problem: `scope "${name}" points outside the repository (config: ${configDir})`,
        });
      } else if ((await pathKind(setupDir)) !== "dir") {
        problems.push({
          file: relative,
          line: 1,
          kind: "structural",
          problem: `scope "${name}" has no ${configDir}/${CONFIG_DIRNAME}/ directory`,
        });
      }
    }
    if (index.files.length > 0) {
      for (const pattern of stringArray(entry.paths)) {
        const variants = [pattern, pattern.replace(/\*\*\//g, "")];
        if (
          !index.files.some((repoFile) => variants.some((v) => v && matchesIgnore(repoFile, v)))
        ) {
          problems.push({
            file: relative,
            line: 1,
            kind: "structural",
            problem: `scope "${name}" glob matches no file in the repo: ${pattern}`,
          });
        }
      }
    }
  }

  for (const id of enforced) {
    if (!rootAgentIds.has(id)) {
      problems.push({
        file: relative,
        line: 1,
        kind: "structural",
        problem: `enforceAgents names "${id}", but the root setup has no agents/${id}.md`,
      });
    }
  }
  return problems;
}

/** Agent ids in a setup dir (id = filename without `.md`, per the loader). */
async function agentIds(setupDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(path.join(setupDir, "agents"));
    return new Set(entries.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
  } catch {
    return new Set();
  }
}

export interface CheckConfigRefsOptions {
  /** Repo root. Refs resolve against this tree — in CI, the PR head checkout. */
  root: string;
  /** Restrict the sweep to these setup dirs (absolute). Default: every one in the repo. */
  setupDirs?: string[];
}

// @ref LLP 0012#run-points-command-and-review [implements] — one pure-ish entry point both the command and the review call
/**
 * Check every code citation in the repo's review setup. Deterministic, no model, no
 * network: refs either resolve against the tree or they do not.
 */
export async function checkConfigRefs(options: CheckConfigRefsOptions): Promise<RefCheckReport> {
  const root = path.resolve(options.root);
  const index: RepoIndex = { root, files: await listRepoFiles(root) };
  const dirs = options.setupDirs ?? (await discoverSetupDirs(root));

  const problems: RefProblem[] = [];
  const refs: ParsedRef[] = [];
  const scannedFiles: string[] = [];
  const citedPaths = new Set<string>();

  // Does an extensionless token name something real? Cached: prompts repeat the same
  // paths, and each miss would otherwise cost a stat per occurrence.
  const resolvable = new Map<string, string | null>();
  /** The root-relative path an extensionless token names, or null if it names nothing. */
  const namedPath = async (token: string, scopeRoot: string): Promise<string | null> => {
    for (const candidate of pathishCandidates(token)) {
      for (const base of [root, scopeRoot]) {
        const absolute = path.resolve(base, candidate);
        let resolved = resolvable.get(absolute);
        if (resolved === undefined) {
          const kind = pathInside(absolute, root) ? await pathKind(absolute) : "missing";
          resolved =
            kind === "missing"
              ? null
              : path.relative(root, absolute).split(path.sep).join("/") +
                (kind === "dir" ? "/" : "");
          resolvable.set(absolute, resolved);
        }
        if (resolved) {
          return resolved;
        }
      }
    }
    return null;
  };

  for (const dir of dirs) {
    const scopeRoot = path.dirname(dir);
    for (const file of await setupFiles(dir)) {
      const relative = fileLabel(root, dir, file);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      scannedFiles.push(relative);

      const annotated = parseRefAnnotations(text, relative);
      const ignored = parseRefIgnores(text);
      const covered = new Set(annotated.flatMap((ref) => coveringForms(ref.target)));
      // A glob ref also covers any citation the glob itself matches, so a prompt can
      // cite `.../nested/Handler.kt` and pin it once with `glob:**/Handler.kt`.
      const coveringGlobs = annotated
        .filter((ref) => ref.target.startsWith(GLOB_PREFIX))
        .map((ref) => ref.target.slice(GLOB_PREFIX.length));

      for (const ref of annotated) {
        const problem = await resolveTarget(ref.target, index, scopeRoot);
        if (problem) {
          problems.push({
            file: relative,
            line: ref.line,
            kind: problem.startsWith("cites a line number") ? "line-number-ref" : "broken-ref",
            problem,
          });
          continue;
        }
        // An `LLP NNNN` target belongs to a different mechanism (a design corpus, owned
        // by that repo's own checker). ecr neither resolves nor counts it: the refs it
        // owns are the ones citing the reviewed code.
        if (LLP_TARGET_RE.test(ref.target)) {
          continue;
        }
        refs.push(ref);
        const cited = splitAnchor(ref.target)[0];
        if (cited && !cited.startsWith(GLOB_PREFIX) && !URL_RE.test(cited)) {
          citedPaths.add(cited.replace(/\/$/, ""));
        }
      }

      for (const { line, token } of findProseCitations(text)) {
        // Extension or wildcard tail ⇒ a citation on shape alone. Otherwise it only
        // counts if it names something real: `eas-build-worker/terraform` and
        // `general-central/{module,production}` are paths, `anthropic/claude-opus-5`
        // is shaped identically and is not.
        const named = isCodeCitation(token) ? null : await namedPath(token, scopeRoot);
        if (!isCodeCitation(token) && !named) {
          continue;
        }
        // Coverage must accept the path the token RESOLVED to, not just the token as
        // written: a prompt says `cert-manager` and the ref that pins it is
        // `infrastructure/cert-manager/`. Without this, the fix the message suggests
        // does not silence the citation it was suggested for.
        const forms = [...citationForms(token), ...(named ? coveringForms(named) : [])];
        if (
          ignored.has(token) ||
          forms.some((form) => covered.has(form)) ||
          coveringGlobs.some((pattern) =>
            forms.some((form) => matchesIgnore(form.replace(/^\.\.\.\//, ""), pattern)),
          )
        ) {
          continue;
        }
        const lineCitation = LINE_CITATION_RE.exec(token);
        // For an extensionless token the suggestion is the path that actually resolved,
        // which is also how a scope-relative citation learns its root-relative form.
        const suggestion = named ?? suggestedRef(token);
        problems.push({
          file: relative,
          line,
          kind: lineCitation ? "line-number-ref" : "unannotated-citation",
          problem: lineCitation
            ? `\`${token}\` pins a line number; cite the file or a \`#symbol\` instead, as \`${REF_MARK} ${suggestedRef(lineCitation[1]!)}\``
            : `\`${token}\` cites code without a ref; add \`${REF_MARK} ${suggestion} — why it matters\` (or \`${IGNORE_MARK} ${token}\` if it is not a path)`,
        });
      }
    }

    const routing = path.join(dir, ROUTING_FILENAME);
    if ((await pathKind(routing)) === "file") {
      // The roster comes from the dir that OWNS the manifest, never from `root`:
      // under `ecr ci` the setup is a trusted base-ref checkout while `root` is the PR
      // head tree, so reading `root/.expo-code-review/agents` would judge enforceAgents
      // against a different (or absent) roster than the one actually loaded.
      problems.push(...(await checkRoutingManifest(routing, index, await agentIds(dir))));
    }
  }

  problems.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.problem.localeCompare(b.problem),
  );
  return {
    ok: problems.length === 0,
    problems,
    refs,
    scannedFiles,
    citedPaths: [...citedPaths].sort(),
  };
}

/** How many examples a review-side note names before saying "and N more". */
const NOTE_EXAMPLES = 5;

function andMore(items: string[]): string {
  const shown = items.slice(0, NOTE_EXAMPLES).join(", ");
  const rest = items.length - NOTE_EXAMPLES;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

// @ref LLP 0012#run-points-command-and-review [constrained-by] — advises, never fails the review
/**
 * The advice a review gives about its own setup: refs that no longer resolve, and cited
 * code this PR changes (where the ref still resolves but the guidance may not). Returns
 * an empty array when the setup is clean, so a healthy run stays silent.
 */
export async function reviewSetupRefNotes(options: {
  root: string;
  setupDirs: string[];
  changedFiles: string[];
}): Promise<string[]> {
  let report: RefCheckReport;
  try {
    report = await checkConfigRefs({ root: options.root, setupDirs: options.setupDirs });
  } catch {
    return []; // a check that cannot run must never degrade the review
  }
  const notes: string[] = [];
  const broken = report.problems.filter((problem) => problem.kind !== "unannotated-citation");
  if (broken.length > 0) {
    notes.push(
      `The reviewer setup cites code that no longer resolves (${broken.length} ref(s)): ` +
        `${andMore(broken.map((problem) => `${problem.file}:${problem.line}`))}. ` +
        "Run `ecr ref-check` — the prompts may be reviewing against code that moved.",
    );
  }
  const touched = citedPathsTouchedBy(report, options.changedFiles);
  if (touched.length > 0) {
    notes.push(
      `This PR changes code the reviewer prompts cite (${andMore(touched)}). ` +
        "Check that the guidance quoting it is still correct.",
    );
  }
  return notes;
}

/**
 * Which of this PR's changed files are cited by a ref. The review uses this to say
 * "you moved code the reviewer prompts point at" even when the ref still resolves.
 */
export function citedPathsTouchedBy(report: RefCheckReport, changedFiles: string[]): string[] {
  const touched = new Set<string>();
  for (const changed of changedFiles) {
    for (const cited of report.citedPaths) {
      if (changed === cited || changed.startsWith(`${cited}/`)) {
        touched.add(cited);
      }
    }
  }
  return [...touched].sort();
}
