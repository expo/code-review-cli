// @ref LLP 0007#session-archive [implements] — one OpenCode export per pass, published only when SESSION_STORE_REPO is set
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { z } from "zod";

import { FORBIDDEN_TOKEN_ENVS } from "./auth.js";
import { resolveTrustedTool, run } from "./exec.js";
import { errorMessage } from "./util.js";

/** Where `ecr attach` looks when SESSION_STORE_REPO is unset. */
export const DEFAULT_SESSION_STORE_REPO = "expo/code-review-sessions";

/** Skip the upload past this size. One GitHub release asset may be far larger. */
export const SESSION_ZIP_LIMIT_BYTES = 80 * 1024 * 1024;

/**
 * One `opencode export` takes under a second.
 * The review comment waits for the exports, so a stalled one has to be cut short.
 */
const EXPORT_TIMEOUT_MS = 30_000;
/** All exports of one `runReview` call share this many timeouts. */
const EXPORT_BUDGET_TIMEOUTS = 4;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** A recorded export stops at this size. */
const EXPORT_LIMIT_BYTES = 96 * 1024 * 1024;

/** The most one archive entry may unpack to. A recorded export stops at 96 MB. */
export const SESSION_ENTRY_LIMIT_BYTES = 128 * 1024 * 1024;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PASS_FILE = /^opencode\/[^/]+\.json$/;

/**
 * Passes that are not a reviewer. Attach opens the first reviewer pass unless
 * `--agent` names one of these.
 */
export const NON_REVIEWER_AGENTS = new Set([
  "coordinator",
  "verifier",
  "cross-cutting",
  "adjudicator",
  "stack-verifier",
]);

export type SessionEngine = "claude" | "opencode" | "codex" | "grok";

export interface SessionIndexPass {
  agent: string;
  /** The pass title, such as `review-correctness-c1`. It tells the chunks of one agent apart. */
  title: string;
  /** The routing scope that ran the pass. Absent in single-config mode. */
  scope?: string;
  sessionId: string;
  file: string;
  source: SessionEngine;
}

export interface SessionIndex {
  repo: string;
  pullRequest: number;
  headSha: string;
  runUrl?: string;
  createdAt: string;
  cliVersion: string;
  opencodeVersion: string;
  passes: SessionIndexPass[];
}

interface RecordedPass {
  agent: string;
  title: string;
  scope?: string;
  source: SessionEngine;
  sessionId: string;
  exportJson?: string;
  order: number;
}

export interface SessionCapture {
  /** The same capture. Passes noted through the result are filed under `scope`. */
  withScope(scope: string): SessionCapture;
  preferReviewerOrder(agentIds: string[]): void;
  note(input: {
    agent: string;
    title: string;
    source: SessionEngine;
    sessionId: string;
    exportJson?: string;
  }): void;
  exportOpencode(input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    bin: string;
    log: (line: string) => void;
    closeServer: () => void;
    /** Limit for one export. Defaults to 30 seconds. */
    timeoutMs?: number;
  }): Promise<void>;
  /** Forget the passes filed under this capture's scope. */
  discard(): void;
  /** Reviewer ids first, in config order, then everything else. */
  orderedPasses(): RecordedPass[];
  readonly count: number;
}

const require = createRequire(import.meta.url);

export function cliVersion(): string {
  return (require("../../package.json") as { version: string }).version;
}

export function pinnedOpencodeVersion(): string {
  return (require("opencode-ai/package.json") as { version: string }).version;
}

/** Drop well-known CI secrets before a model process starts. */
export function opencodeChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of FORBIDDEN_TOKEN_ENVS) {
    delete env[name];
  }
  return env;
}

export function createSessionCapture(): SessionCapture {
  return scopedCapture([], [], undefined);
}

function scopedCapture(
  passes: RecordedPass[],
  reviewerOrder: string[],
  scope: string | undefined,
): SessionCapture {
  const orderedPasses = (): RecordedPass[] => {
    const rank = new Map(reviewerOrder.map((id, index) => [id, index]));
    return [...passes].sort((a, b) => {
      const aRank = rank.get(a.agent);
      const bRank = rank.get(b.agent);
      const aReviewer = aRank !== undefined;
      const bReviewer = bRank !== undefined;
      if (aReviewer !== bReviewer) {
        return aReviewer ? -1 : 1;
      }
      if (aReviewer && bReviewer && aRank !== bRank) {
        return (aRank ?? 0) - (bRank ?? 0);
      }
      return a.order - b.order;
    });
  };

  return {
    withScope: (name) => scopedCapture(passes, reviewerOrder, name),
    preferReviewerOrder(agentIds: string[]): void {
      for (const id of agentIds) {
        if (!reviewerOrder.includes(id)) {
          reviewerOrder.push(id);
        }
      }
    },
    note(input): void {
      // The router borrows the coordinator agent. It is not a review pass.
      if (!input.sessionId || input.title === "route") {
        return;
      }
      const order = (passes.at(-1)?.order ?? -1) + 1;
      passes.push({ ...input, ...(scope ? { scope } : {}), order });
    },
    discard(): void {
      // Every scope shares this array, so it is changed in place.
      for (let index = passes.length - 1; index >= 0; index -= 1) {
        if (passes[index]!.scope === scope) {
          passes.splice(index, 1);
        }
      }
    },
    async exportOpencode(input): Promise<void> {
      // A pass that another scope could not export stays failed.
      // Its scope already retried it and logged it.
      const pending = (): RecordedPass[] =>
        passes.filter(
          (pass) => pass.source === "opencode" && !pass.exportJson && pass.scope === scope,
        );
      if (pending().length === 0) {
        return;
      }
      const timeoutMs = input.timeoutMs ?? EXPORT_TIMEOUT_MS;
      const limits = { timeoutMs, deadline: Date.now() + timeoutMs * EXPORT_BUDGET_TIMEOUTS };
      await exportPasses(pending(), input, limits);
      const failed = pending();
      if (failed.length === 0) {
        return;
      }
      // The server can hold the session database. Close it and read once more.
      input.closeServer();
      await exportPasses(failed, input, limits);
      for (const pass of pending()) {
        input.log(`session store: could not export ${pass.agent} (${pass.sessionId})`);
      }
    },
    orderedPasses,
    get count(): number {
      return passes.length;
    },
  };
}

async function exportPasses(
  pending: RecordedPass[],
  input: { cwd: string; env: NodeJS.ProcessEnv; bin: string },
  limits: { timeoutMs: number; deadline: number },
): Promise<void> {
  const pinned = pinnedOpencodeVersion();
  for (const pass of pending) {
    const left = limits.deadline - Date.now();
    if (left <= 0) {
      return;
    }
    try {
      const json = await exportOpencodeSession(
        input.bin,
        pass.sessionId,
        input.cwd,
        input.env,
        Math.min(limits.timeoutMs, left),
      );
      if (exportVersion(json) !== pinned) {
        continue;
      }
      pass.exportJson = json;
      const id = sessionIdOf(json);
      if (id) {
        pass.sessionId = id;
      }
    } catch {
      // The caller logs whatever is still missing after the retry.
    }
  }
}

async function exportOpencodeSession(
  bin: string,
  sessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-export-"));
  try {
    const file = path.join(dir, "export.json");
    const result = await run(bin, ["export", sessionId, "--pure"], {
      cwd,
      env: opencodeChildEnv(env),
      check: false,
      timeout,
      // The pinned CLI can exit before a pipe is drained, which cuts a large export short.
      // A file also selects the spawn path, whose timeout stops the whole process group.
      stdoutPath: file,
    });
    if (result.timedOut || result.code !== 0 || (await stat(file)).size > EXPORT_LIMIT_BYTES) {
      throw new Error("export failed");
    }
    const json = (await readFile(file, "utf8")).trim();
    if (!sessionIdOf(json)) {
      throw new Error("export had no session");
    }
    return json;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function exportVersion(json: string): string | undefined {
  try {
    const version = (JSON.parse(json) as { info?: { version?: unknown } }).info?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

export function sessionIdOf(json: string): string | undefined {
  try {
    const id = (JSON.parse(json) as { info?: { id?: unknown } }).info?.id;
    return typeof id === "string" && id.startsWith("ses") ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse an export the pinned binary cannot read.
 * The check is the export's own version string, which OpenCode stamps at creation.
 * `archiveCliVersion` is the `cliVersion` of the archive index.
 */
export function assertReadableExport(json: string, archiveCliVersion?: string): void {
  const version = exportVersion(json);
  const pinned = pinnedOpencodeVersion();
  if (version !== pinned) {
    throw new Error(
      [
        `This session was exported by OpenCode ${version ?? "unknown"}.`,
        `The pinned OpenCode is ${pinned} and cannot read it.`,
        ...fixForUnreadableExport(archiveCliVersion),
      ].join(" "),
    );
  }
}

function fixForUnreadableExport(archiveCliVersion: string | undefined): string[] {
  if (archiveCliVersion === cliVersion()) {
    // This ecr made the archive, so another version is not the fix.
    return [];
  }
  // The index is a download, and this text names a command to run.
  // Only a plain release version goes into it.
  if (!archiveCliVersion || !RELEASE_VERSION_PATTERN.test(archiveCliVersion)) {
    return ["Use the ecr version that made the archive."];
  }
  return [
    `Run \`npx @expo/code-review-cli@${archiveCliVersion} attach\` with the same arguments.`,
    "That version made the archive.",
  ];
}

export function defaultSessionPass(passes: SessionIndexPass[]): SessionIndexPass | undefined {
  return passes.find((pass) => !NON_REVIEWER_AGENTS.has(pass.agent));
}

/** True when attach must stop instead of importing into a different commit. */
export function recordedShaBlocksAttach(checkoutSha: string, recordedSha: string): boolean {
  return checkoutSha.toLowerCase() !== recordedSha.toLowerCase();
}

export function zipTooLarge(bytes: number): boolean {
  return bytes > SESSION_ZIP_LIMIT_BYTES;
}

function assertRepo(repo: string): [string, string] {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`Repository must look like owner/name, got ${JSON.stringify(repo)}.`);
  }
  const [owner, name] = repo.split("/");
  for (const part of [owner!, name!]) {
    // Git refuses these in a tag, and the names are path parts of the release tag.
    if (part.startsWith(".") || part.endsWith(".lock") || part.includes("..")) {
      throw new Error(`No session can be stored for ${repo}. A git tag cannot contain "${part}".`);
    }
  }
  return [owner!, name!];
}

function assertSha(headSha: string): string {
  const sha = headSha.toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error("The head SHA must be 40 hex characters.");
  }
  return sha;
}

/** `session/<owner>/<repo>/<pr>/<head12>/<runId>`, with a trailing slash before the run id. */
export function sessionTagPrefix(repo: string, pr: number, headSha: string): string {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error("The pull request number must be a positive integer.");
  }
  const [owner, name] = assertRepo(repo);
  const sha = assertSha(headSha);
  return `session/${owner}/${name}/${pr}/${sha.slice(0, 12)}/`;
}

export function sessionTag(repo: string, pr: number, headSha: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("The run id can only contain letters, numbers, dots, underscores, and dashes.");
  }
  return `${sessionTagPrefix(repo, pr, headSha)}${runId}`;
}

export function storeRunId(): string {
  const raw = process.env.GITHUB_RUN_ID?.trim();
  const attempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
  const base = raw && /^[0-9]+$/.test(raw) ? raw : new Date().toISOString().replace(/[:.]/g, "-");
  if (raw && attempt && attempt !== "1" && /^[0-9]+$/.test(attempt)) {
    return `${base}-${attempt}`;
  }
  return base;
}

export function workflowRunUrl(): string | undefined {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const id = process.env.GITHUB_RUN_ID;
  if (!server || !repo || !id) {
    return undefined;
  }
  return `${server}/${repo}/actions/runs/${id}`;
}

export interface ListedRelease {
  tag: string;
  /**
   * When the archive was uploaded.
   * A release's `createdAt` is the date of the commit under its tag, the same for every archive.
   */
  publishedAt: string;
}

/** Newest first. The run id is the only segment after the prefix. */
export function releasesForHead(releases: ListedRelease[], prefix: string): ListedRelease[] {
  return releases
    .filter((release) => {
      if (!release.tag.startsWith(prefix)) {
        return false;
      }
      const rest = release.tag.slice(prefix.length);
      return rest.length > 0 && !rest.includes("/");
    })
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
}

function safeAgentFile(agent: string, used: Set<string>): string {
  const base = agent.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/g, "") || "agent";
  let name = `opencode/${base}.json`;
  let n = 2;
  while (used.has(name)) {
    name = `opencode/${base}-${n}.json`;
    n++;
  }
  used.add(name);
  return name;
}

export function buildSessionIndex(
  capture: SessionCapture,
  input: { repo: string; pr: number; headSha: string },
): { index: SessionIndex; files: { name: string; data: Buffer }[] } | null {
  const used = new Set<string>();
  const files: { name: string; data: Buffer }[] = [];
  const passes: SessionIndexPass[] = [];
  for (const pass of capture.orderedPasses()) {
    if (!pass.exportJson) {
      continue;
    }
    const file = safeAgentFile(pass.agent, used);
    files.push({ name: file, data: Buffer.from(pass.exportJson, "utf8") });
    passes.push({
      agent: pass.agent,
      title: pass.title,
      ...(pass.scope ? { scope: pass.scope } : {}),
      sessionId: pass.sessionId,
      file,
      source: pass.source,
    });
  }
  if (passes.length === 0) {
    return null;
  }
  const index: SessionIndex = {
    repo: input.repo,
    pullRequest: input.pr,
    headSha: input.headSha.toLowerCase(),
    ...(workflowRunUrl() ? { runUrl: workflowRunUrl() } : {}),
    createdAt: new Date().toISOString(),
    cliVersion: cliVersion(),
    opencodeVersion: pinnedOpencodeVersion(),
    passes,
  };
  return { index, files };
}

export function renderIndexMarkdown(index: SessionIndex): string {
  const lines = [
    `# ${index.repo}#${index.pullRequest}`,
    "",
    `- repo: ${index.repo}`,
    `- pull request: ${index.pullRequest}`,
    `- head: ${index.headSha}`,
    `- created: ${index.createdAt}`,
    `- cli: ${index.cliVersion}`,
    `- opencode: ${index.opencodeVersion}`,
    ...(index.runUrl ? [`- run: ${index.runUrl}`] : []),
    "",
    "| agent | title | scope | session | file | source |",
    "| --- | --- | --- | --- | --- | --- |",
    ...index.passes.map(
      (pass) =>
        `| ${pass.agent} | ${pass.title} | ${pass.scope ?? ""} | ${pass.sessionId} | ${pass.file} | ${pass.source} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

const SessionIndexSchema: z.ZodType<SessionIndex> = z.object({
  repo: z.string(),
  pullRequest: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  runUrl: z.string().optional(),
  createdAt: z.string(),
  cliVersion: z.string(),
  opencodeVersion: z.string(),
  passes: z.array(
    z.object({
      agent: z.string().min(1),
      title: z.string(),
      scope: z.string().optional(),
      // Attach passes this id to `opencode attach --session`.
      sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/),
      file: z.string().regex(PASS_FILE),
      source: z.enum(["claude", "opencode", "codex", "grok"]),
    }),
  ),
});

/** The index comes from a download, so every field is checked before attach uses it. */
export function parseSessionIndex(json: string): SessionIndex {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("The session index is not JSON.");
  }
  const parsed = SessionIndexSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "index";
    throw new Error(`The session index is not valid (${where}: ${issue?.message ?? "unknown"}).`);
  }
  return parsed.data;
}

function scrubSecrets(text: string): string {
  let out = text;
  for (const name of FORBIDDEN_TOKEN_ENVS) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      out = out.split(value).join(`[${name}]`);
    }
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function publishSessionArchive(input: {
  capture: SessionCapture;
  repo: string;
  pr: number;
  headSha: string | undefined;
  log: (line: string) => void;
}): Promise<void> {
  const store = process.env.SESSION_STORE_REPO?.trim();
  if (!store) {
    return;
  }
  try {
    if (!input.headSha || !SHA_PATTERN.test(input.headSha.toLowerCase())) {
      input.log("session store: not publishing; the PR head SHA is unknown");
      return;
    }
    const built = buildSessionIndex(input.capture, {
      repo: input.repo,
      pr: input.pr,
      headSha: input.headSha,
    });
    if (!built) {
      input.log("session store: no session to publish");
      return;
    }
    const tag = sessionTag(input.repo, input.pr, input.headSha, storeRunId());
    const dir = await mkdtemp(path.join(tmpdir(), "ecr-session-"));
    try {
      const zipPath = path.join(dir, "sessions.zip");
      const notesPath = path.join(dir, "index.md");
      const zip = zipEntries([
        { name: "index.json", data: Buffer.from(JSON.stringify(built.index, null, 2), "utf8") },
        ...built.files,
      ]);
      if (zipTooLarge(zip.length)) {
        const mb = (zip.length / (1024 * 1024)).toFixed(1);
        input.log(`session store: sessions.zip is ${mb} MB, over the 80 MB limit; not uploading`);
        return;
      }
      await writeFile(zipPath, zip);
      await writeFile(notesPath, renderIndexMarkdown(built.index), "utf8");
      const gh = await resolveTrustedTool("gh");
      const created = await run(
        gh,
        [
          "release",
          "create",
          tag,
          zipPath,
          "--repo",
          store,
          "--title",
          tag,
          "--notes-file",
          notesPath,
        ],
        { timeout: UPLOAD_TIMEOUT_MS },
      );
      // A timeout resolves instead of throwing, so it must not read as success.
      if (created.timedOut) {
        throw new Error("gh release create did not finish in 5 minutes");
      }
      input.log(`session store: uploaded ${tag} to ${store}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    input.log(`session store: upload failed: ${scrubSecrets(errorMessage(error))}`);
  }
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A deflated zip. Entry names are the archive paths (`index.json`, `opencode/<agent>.json`). */
export function zipEntries(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * List the entries of a session archive.
 * An entry is unpacked when it is read, and never past `entryLimit`.
 */
export function unzipEntries(
  buffer: Buffer,
  entryLimit = SESSION_ENTRY_LIMIT_BYTES,
): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  let pos = 0;
  while (pos + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(pos);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50) {
      throw new Error("The session archive is not a zip file.");
    }
    const flags = buffer.readUInt16LE(pos + 6);
    const method = buffer.readUInt16LE(pos + 8);
    const compressedSize = buffer.readUInt32LE(pos + 18);
    const nameLength = buffer.readUInt16LE(pos + 26);
    const extraLength = buffer.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    if (flags & 0x0008) {
      throw new Error("The session archive uses a zip feature this CLI does not read.");
    }
    if (name !== "index.json" && !PASS_FILE.test(name)) {
      throw new Error(`The session archive has an unexpected file: ${name}`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`The session archive uses an unsupported compression method (${method}).`);
    }
    const dataStart = nameStart + nameLength + extraLength;
    const packed = buffer.subarray(dataStart, dataStart + compressedSize);
    out.set(name, () => unpackEntry(name, method === 0, packed, entryLimit));
    pos = dataStart + compressedSize;
  }
  return out;
}

function unpackEntry(name: string, stored: boolean, packed: Buffer, limit: number): Buffer {
  const tooLarge = new Error(`The session archive entry ${name} is too large to unpack.`);
  if (stored) {
    if (packed.length > limit) {
      throw tooLarge;
    }
    return Buffer.from(packed);
  }
  try {
    return inflateRawSync(packed, { maxOutputLength: limit });
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? tooLarge : error;
  }
}

export async function assertArchiveSize(file: string): Promise<void> {
  const info = await stat(file);
  if (zipTooLarge(info.size)) {
    throw new Error("The session archive is over 80 MB. Refusing to unpack it.");
  }
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

type NewId = (prefix: "ses" | "msg" | "prt") => string;

/**
 * OpenCode sorts messages and parts by id, so each id must be greater than the last.
 * Same shape as OpenCode's own ids: 12 hex digits of time, then 14 random characters.
 */
function ascendingIds(startMs: number): NewId {
  let clock = BigInt(startMs) * 0x1000n;
  return (prefix) => {
    clock += 1n;
    const time = (clock & 0xffffffffffffn).toString(16).padStart(12, "0");
    let tail = "";
    for (const byte of randomBytes(14)) {
      tail += ID_ALPHABET[byte % 62];
    }
    return `${prefix}_${time}${tail}`;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelParts(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
  return { providerID: "anthropic", modelID: model };
}

function displayPath(value: unknown, cwd: string): unknown {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    return value;
  }
  const root = path.resolve(cwd);
  const absolute = path.resolve(value);
  if (absolute === root || absolute.startsWith(root + path.sep)) {
    return path.relative(root, absolute).replaceAll("\\", "/") || ".";
  }
  return "(outside the review tree)";
}

function toolInput(input: unknown, cwd: string): Record<string, unknown> {
  const record = asRecord(input) ?? {};
  const copy: Record<string, unknown> = { ...record };
  for (const key of ["file_path", "path", "filename"]) {
    if (key in copy) {
      copy[key] = displayPath(copy[key], cwd);
    }
  }
  return copy;
}

function toolOutput(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = asRecord(block);
        return typeof record?.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content);
}

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Grep: "grep",
  Glob: "glob",
};

interface ClaudeTurn {
  text: string[];
  tools: { id: string; name: string; input: Record<string, unknown> }[];
}

/**
 * Build an OpenCode 1.19.5 export from one `claude -p` stream.
 * The prompt is the stdin this run already sent. The stream is the stdout it already read.
 * Host paths in tool inputs are rewritten to repo-relative paths.
 */
export function buildClaudeSessionExport(input: {
  agent: string;
  system: string;
  text: string;
  model: string;
  cwd: string;
  stdout: string;
  cost: number;
  tokens: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}): { sessionId: string; json: string } {
  const now = Date.now();
  const newId = ascendingIds(now);
  const sessionId = newId("ses");
  const userId = newId("msg");
  const { providerID, modelID } = modelParts(input.model);
  const toolResults = new Map<string, string>();
  const turns: ClaudeTurn[] = [];
  let resultText = "";

  for (const line of input.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) {
        continue;
      }
      event = parsed;
    } catch {
      continue;
    }
    if (event.type === "result" && event.is_error !== true && typeof event.result === "string") {
      resultText = event.result;
      continue;
    }
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    if (event.type === "user") {
      for (const block of content) {
        const record = asRecord(block);
        if (record?.type === "tool_result" && typeof record.tool_use_id === "string") {
          toolResults.set(record.tool_use_id, toolOutput(record.content));
        }
      }
      continue;
    }
    if (event.type !== "assistant") {
      continue;
    }
    const turn: ClaudeTurn = { text: [], tools: [] };
    for (const block of content) {
      const record = asRecord(block);
      if (!record) {
        continue;
      }
      if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
        turn.text.push(record.text);
      } else if (
        (record.type === "thinking" || record.type === "reasoning") &&
        typeof (record.thinking ?? record.text) === "string"
      ) {
        const thinking = record.thinking ?? record.text;
        if (typeof thinking === "string" && thinking.trim()) {
          turn.text.push(thinking);
        }
      } else if (record.type === "tool_use" && typeof record.name === "string") {
        turn.tools.push({
          id: typeof record.id === "string" ? record.id : newId("prt"),
          name: CLAUDE_TOOL_NAMES[record.name] ?? record.name,
          input: toolInput(record.input, input.cwd),
        });
      }
    }
    if (turn.text.length > 0 || turn.tools.length > 0) {
      turns.push(turn);
    }
  }
  if (resultText && !turns.some((turn) => turn.text.includes(resultText))) {
    turns.push({ text: [resultText], tools: [] });
  }

  const tokens = {
    input: input.tokens.input ?? 0,
    output: input.tokens.output ?? 0,
    reasoning: input.tokens.reasoning ?? 0,
    cache: {
      read: input.tokens.cache?.read ?? 0,
      write: input.tokens.cache?.write ?? 0,
    },
  };
  const part = (messageId: string, body: Record<string, unknown>): Record<string, unknown> => ({
    id: newId("prt"),
    sessionID: sessionId,
    messageID: messageId,
    ...body,
  });
  const messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[] = [
    {
      info: {
        id: userId,
        sessionID: sessionId,
        role: "user",
        time: { created: now },
        agent: input.agent,
        model: { providerID, modelID },
        ...(input.system ? { system: input.system } : {}),
      },
      parts: [part(userId, { type: "text", text: input.text })],
    },
  ];
  const noTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  for (const [index, turn] of turns.entries()) {
    const messageId = newId("msg");
    const at = now + index + 1;
    // The stream reports one total for the pass. Only the last turn carries it.
    const last = index === turns.length - 1;
    const spent = last ? tokens : noTokens;
    const parts: Record<string, unknown>[] = [];
    for (const text of turn.text) {
      parts.push(part(messageId, { type: "text", text }));
    }
    for (const tool of turn.tools) {
      parts.push(
        part(messageId, {
          type: "tool",
          callID: tool.id,
          tool: tool.name,
          state: {
            status: "completed",
            input: tool.input,
            output: toolResults.get(tool.id) ?? "",
            title: tool.name,
            metadata: {},
            time: { start: at, end: at },
          },
        }),
      );
    }
    messages.push({
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
        time: { created: at, completed: at },
        parentID: userId,
        modelID,
        providerID,
        mode: input.agent,
        agent: input.agent,
        path: { cwd: ".", root: "." },
        cost: last ? input.cost : 0,
        tokens: { ...spent, total: spent.input + spent.output + spent.reasoning },
      },
      parts,
    });
  }

  const exported = {
    info: {
      id: sessionId,
      slug: "ecr-session",
      projectID: "global",
      directory: ".",
      title: input.agent,
      agent: input.agent,
      model: { id: modelID, providerID },
      version: pinnedOpencodeVersion(),
      cost: input.cost,
      tokens,
      time: { created: now, updated: now + turns.length },
    },
    messages,
  };
  return { sessionId, json: JSON.stringify(exported) };
}
