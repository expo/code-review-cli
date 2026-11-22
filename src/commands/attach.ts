// @ref LLP 0007#session-archive [implements] — import with the pinned OpenCode, then attach --fork; never switch branches
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  git,
  repoRoot,
  resolveRepo,
  resolveTrustedTool,
  run,
  spawnInherited,
  spawnPiped,
} from "../core/exec.js";
import { resolveOpencodeCli } from "../core/opencode.js";
import {
  assertArchiveSize,
  assertReadableExport,
  DEFAULT_SESSION_STORE_REPO,
  defaultSessionPass,
  opencodeChildEnv,
  parseSessionIndex,
  recordedShaBlocksAttach,
  releasesForHead,
  sessionTag,
  sessionTagPrefix,
  unzipEntries,
} from "../core/session-archive.js";
import type { ListedRelease, SessionIndexPass } from "../core/session-archive.js";
import { errorMessage } from "../core/util.js";

const USAGE = `ecr attach — reopen a finished review in OpenCode

Usage:
  ecr attach --pr <n> [--repo <owner/repo>] [--sha <head>] [--run <id>] [--agent <id>] [--list]

Downloads the session archive for a pull request and opens one pass in the
OpenCode shipped with this CLI. The store is SESSION_STORE_REPO, or
${DEFAULT_SESSION_STORE_REPO} when that is unset.

--repo defaults from the checkout's git remote. --list prints matches and does
not download. With --run the tag is fetched directly. Otherwise the newest
archive for the checkout's HEAD is used. If that archive recorded a different
commit, attach stops and prints the SHA. It does not switch branches.

--agent picks a pass. The default is the first reviewer pass.
`;

interface AttachArgs {
  pr?: number;
  repo?: string;
  sha?: string;
  run?: string;
  agent?: string;
  list: boolean;
}

function parseArgs(argv: string[]): AttachArgs {
  const args: AttachArgs = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--pr":
        args.pr = Number(argv[++i]);
        break;
      case "--repo":
        args.repo = argv[++i];
        break;
      case "--sha":
        args.sha = argv[++i];
        break;
      case "--run":
        args.run = argv[++i];
        break;
      case "--agent":
        args.agent = argv[++i];
        break;
      case "--list":
        args.list = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function storeRepo(): string {
  return process.env.SESSION_STORE_REPO?.trim() || DEFAULT_SESSION_STORE_REPO;
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

async function listReleases(store: string, cwd: string): Promise<ListedRelease[]> {
  const gh = await resolveTrustedTool("gh");
  const { stdout } = await run(
    gh,
    ["release", "list", "--repo", store, "--limit", "1000", "--json", "tagName,createdAt"],
    { cwd },
  );
  const rows = JSON.parse(stdout) as { tagName?: string; createdAt?: string }[];
  return rows.flatMap((row) =>
    row.tagName ? [{ tag: row.tagName, createdAt: row.createdAt ?? "" }] : [],
  );
}

function printRelease(release: ListedRelease, body?: string): void {
  process.stdout.write(`${release.createdAt || "unknown date"}\t${release.tag}\n`);
  if (body?.trim()) {
    process.stdout.write(`${body.trim()}\n\n`);
  }
}

function pickPass(passes: SessionIndexPass[], agent: string | undefined): SessionIndexPass {
  if (agent) {
    const matches = passes.filter((pass) => pass.agent === agent);
    const chosen = matches[0];
    if (!chosen) {
      const known = [...new Set(passes.map((pass) => pass.agent))].join(", ") || "(none)";
      throw new Error(`No pass named ${agent}. This archive has: ${known}`);
    }
    if (matches.length > 1) {
      process.stderr.write(
        `attach: ${matches.length} passes named ${agent}; opening the first (${chosen.sessionId}).\n`,
      );
    }
    return chosen;
  }
  const chosen = defaultSessionPass(passes);
  if (!chosen) {
    throw new Error("This archive has no reviewer pass. Pass --agent to name one.");
  }
  return chosen;
}

async function waitForServer(child: ReturnType<typeof spawnPiped>): Promise<string> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("OpenCode server did not start."));
    }, 30_000);
    const finish = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const detail = stderr.trim().slice(0, 300);
      reject(detail ? new Error(`${error.message} ${detail}`) : error);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = /opencode server listening on (http:\/\/\S+)/.exec(stdout);
      if (match?.[1] && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`OpenCode server exited before listening (${code ?? "unknown"}).`));
      }
    });
  });
}

export async function attachCommand(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  let args: AttachArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.pr == null || !Number.isInteger(args.pr) || args.pr <= 0) {
    fail("attach: --pr <number> is required.");
    return;
  }

  const root = await repoRoot();
  if (root && root !== process.cwd()) {
    process.chdir(root);
  }
  const cwd = process.cwd();

  let repo: string;
  try {
    repo = args.repo ?? (await resolveRepo(cwd));
  } catch (error) {
    fail(`attach: ${errorMessage(error)}`);
    return;
  }

  let checkoutSha: string;
  try {
    checkoutSha = (await git(["rev-parse", "HEAD"], cwd)).trim().toLowerCase();
  } catch (error) {
    fail(`attach: ${errorMessage(error)}`);
    return;
  }
  const headSha = (args.sha ?? checkoutSha).toLowerCase();
  const store = storeRepo();

  try {
    if (args.run) {
      const tag = sessionTag(repo, args.pr, headSha, args.run);
      if (args.list) {
        const gh = await resolveTrustedTool("gh");
        const { stdout } = await run(
          gh,
          ["release", "view", tag, "--repo", store, "--json", "tagName,createdAt,body"],
          { cwd },
        );
        const view = JSON.parse(stdout) as {
          tagName?: string;
          createdAt?: string;
          body?: string;
        };
        printRelease({ tag: view.tagName ?? tag, createdAt: view.createdAt ?? "" }, view.body);
        return;
      }
      await openRelease(tag, store, cwd, checkoutSha, args.agent);
      return;
    }

    const prefix = sessionTagPrefix(repo, args.pr, headSha);
    const matches = releasesForHead(await listReleases(store, cwd), prefix);
    if (matches.length === 0) {
      fail(`attach: no session for ${repo}#${args.pr} at ${headSha.slice(0, 12)}.`);
      return;
    }
    if (args.list) {
      for (const match of matches) {
        printRelease(match);
      }
      return;
    }
    const newest = matches[0];
    if (!newest) {
      fail(`attach: no session for ${repo}#${args.pr} at ${headSha.slice(0, 12)}.`);
      return;
    }
    await openRelease(newest.tag, store, cwd, checkoutSha, args.agent);
  } catch (error) {
    fail(`attach: ${errorMessage(error)}`);
  }
}

async function openRelease(
  tag: string,
  store: string,
  cwd: string,
  checkoutSha: string,
  agent: string | undefined,
): Promise<void> {
  const bin = await resolveOpencodeCli();
  if (!bin) {
    throw new Error("The pinned opencode CLI is not installed. Reinstall this package.");
  }
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-attach-"));
  const server = { current: null as ReturnType<typeof spawnPiped> | null };
  try {
    const gh = await resolveTrustedTool("gh");
    await run(
      gh,
      ["release", "download", tag, "--repo", store, "--pattern", "sessions.zip", "--dir", dir],
      { cwd },
    );
    const zipPath = path.join(dir, "sessions.zip");
    await assertArchiveSize(zipPath);
    const entries = unzipEntries(await readFile(zipPath));
    const indexBytes = entries.get("index.json");
    if (!indexBytes) {
      throw new Error("The session archive has no index.json.");
    }
    const index = parseSessionIndex(indexBytes.toString("utf8"));
    if (recordedShaBlocksAttach(checkoutSha, index.headSha)) {
      throw new Error(
        `This checkout is ${checkoutSha}. The session recorded ${index.headSha}. ` +
          "Check out that commit yourself. Attach does not switch branches.",
      );
    }
    const pass = pickPass(index.passes, agent);
    const exportBytes = entries.get(pass.file);
    if (!exportBytes) {
      throw new Error(`The session archive is missing ${pass.file}.`);
    }
    const exportJson = exportBytes.toString("utf8");
    assertReadableExport(exportJson);
    const exportPath = path.join(dir, "session.json");
    await writeFile(exportPath, exportJson);
    const env = opencodeChildEnv(process.env);
    const imported = await run(bin, ["import", exportPath, "--pure"], {
      cwd,
      env,
      check: false,
    });
    if (imported.code !== 0) {
      throw new Error(imported.stderr.trim() || `opencode import exited ${imported.code}`);
    }
    server.current = spawnPiped(
      bin,
      ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"],
      { cwd, env },
    );
    const url = await waitForServer(server.current);
    const code = await spawnInherited(
      bin,
      ["attach", url, "--session", pass.sessionId, "--dir", cwd, "--fork", "--pure"],
      { cwd, env },
    );
    if (code !== 0) {
      process.exitCode = code;
    }
  } finally {
    server.current?.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
}
