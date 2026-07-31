import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Signal that killed the process, if any (e.g. the kill from a `timeout`). */
  signal?: string;
  /** True when our own deadline fired and killed the child (not a crash signal). */
  timedOut?: boolean;
  /** True when captured stdout/stderr was truncated at maxBuffer. */
  overflowed?: boolean;
}

export interface RunOptions {
  cwd?: string;
  maxBuffer?: number;
  /** When false, a non-zero exit returns the result instead of throwing. */
  check?: boolean;
  /** Child-process environment (defaults to inheriting the parent's). */
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many ms (execFile/spawn native timeout). */
  timeout?: number;
  /** Signal used to kill on timeout (default SIGTERM). */
  killSignal?: NodeJS.Signals;
  /** When set, write this to the child's stdin (routes through spawn, not execFile). */
  input?: string;
}

/**
 * Run a command capturing stdout/stderr. Never interpolates a shell, so
 * arguments are passed verbatim and are not subject to shell injection.
 *
 * With `input`, the call routes through spawn so the text can be streamed to
 * stdin; every other caller keeps the execFile path unchanged.
 */
export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (options.input !== undefined) {
    return runWithInput(command, args, options, options.input);
  }
  const check = options.check ?? true;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      encoding: "utf8",
      env: options.env,
      timeout: options.timeout,
      killSignal: options.killSignal,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number;
      signal?: string;
      killed?: boolean;
    };
    // Same timeout contract as runWithInput: a child our own `timeout` killed
    // resolves with `timedOut: true` (even under check) instead of a generic
    // throw, so callers see one shape regardless of which path ran.
    const timedOut = options.timeout !== undefined && err.killed === true;
    if (!check || timedOut) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        code: err.code ?? 1,
        signal: err.signal,
        timedOut: timedOut || undefined,
      };
    }
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${err.stderr ?? err.message ?? ""}`.trim(),
    );
  }
}

/**
 * Kill callbacks for children still running, so an interrupt or exit never
 * orphans them. Detached children live in their own process group (see
 * runWithInput), so SIGINT from Ctrl-C reaches only this process — without this,
 * an aborted review leaves a credential-bearing `claude` running unbounded.
 */
const liveChildKillers = new Set<() => void>();
let childCleanupInstalled = false;

function installChildCleanup(): void {
  if (childCleanupInstalled) {
    return;
  }
  childCleanupInstalled = true;
  const killAll = (): void => {
    for (const kill of liveChildKillers) {
      kill();
    }
  };
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killAll();
      // Re-raise the conventional exit code; registering a handler suppressed
      // Node's default termination.
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      process.exit();
    });
  }
}

/**
 * spawn-based variant that feeds `input` to the child's stdin. Collects
 * stdout/stderr up to `maxBuffer`, enforces `timeout`/`killSignal` manually, and
 * resolves the same RunResult shape (with `timedOut`/`overflowed` set).
 *
 * The deadline is enforced with our own timers rather than spawn's native
 * `timeout`: spawn sends `killSignal` once, to the direct child only, with no
 * SIGKILL escalation — a child that traps SIGTERM, or a shim wrapper
 * (volta/mise/asdf) whose grandchild holds the work, would run unbounded. Here a
 * child launched detached forms its own process group, we signal the whole group,
 * and a grace timer escalates to SIGKILL.
 */
function runWithInput(
  command: string,
  args: string[],
  options: RunOptions,
  input: string,
): Promise<RunResult> {
  const check = options.check ?? true;
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached,
    });
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };
    // Signal the whole process group when detached so a shim wrapper's grandchild
    // is killed too. On Windows there are no process groups — kill the tree via
    // taskkill instead, for the same reason.
    const killChild = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform === "win32" && child.pid !== undefined) {
          // A no-op error handler is required: an async spawn failure (ENOENT/EPERM)
          // has no other listener here and would otherwise throw unhandled and
          // crash the parent, defeating the point of this cleanup path.
          spawn(taskkillPath(), ["/pid", String(child.pid), "/T", "/F"]).on("error", () => {});
        } else if (detached && child.pid !== undefined) {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        // Already exited, or the group is gone — nothing to kill.
      }
    };
    const emergencyKill = (): void => killChild("SIGKILL");
    installChildCleanup();
    liveChildKillers.add(emergencyKill);
    if (options.timeout && options.timeout > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killChild(options.killSignal ?? "SIGTERM");
        graceTimer = setTimeout(() => killChild("SIGKILL"), 5000);
        graceTimer.unref?.();
      }, options.timeout);
      killTimer.unref?.();
    }
    const cap = (current: string, chunk: string): string => {
      if (current.length >= maxBuffer) {
        overflowed = true;
        return current;
      }
      const next = current + chunk;
      // Check AFTER appending too — a single oversized chunk must both flag the
      // overflow and stay capped, not sail through because the pre-append length
      // was still under the limit.
      if (next.length > maxBuffer) {
        overflowed = true;
        return next.slice(0, maxBuffer);
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = cap(stderr, chunk);
    });
    // A late I/O error on either stream (e.g. the process group getting
    // SIGKILLed mid-read) would otherwise throw unhandled and crash the
    // parent; the close handler reports the real outcome regardless.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (error) => {
      clearTimers();
      liveChildKillers.delete(emergencyKill);
      if (!check) {
        // A spawn error (ENOENT/EACCES) fires before any stderr can be
        // captured, so fall back to error.message rather than resolving
        // with an unexplained empty stderr.
        resolve({ stdout, stderr: stderr || error.message, code: 1, timedOut, overflowed });
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${error.message}`.trim()));
    });
    child.on("close", (code, signal) => {
      clearTimers();
      liveChildKillers.delete(emergencyKill);
      const exitCode = code ?? 1;
      if (overflowed && check) {
        reject(new Error(`Command output exceeded ${maxBuffer} bytes: ${command}`));
        return;
      }
      if (exitCode !== 0 && check && !timedOut) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`.trim()));
        return;
      }
      resolve({
        stdout,
        stderr,
        code: exitCode,
        signal: signal ?? undefined,
        timedOut,
        overflowed,
      });
    });
    child.stdin.on("error", () => {
      // A child that exits before reading stdin (e.g. bad args) closes the pipe;
      // ignore EPIPE — the close handler reports the real outcome.
    });
    child.stdin.end(input);
  });
}

/**
 * Memoized trusted resolutions for the host `git`/`gh` binaries, keyed by name so
 * git()'s many callers share ONE which/where lookup instead of each spawning their
 * own. See resolveTrustedTool.
 */
const trustedToolResolutions = new Map<string, Promise<string>>();

/**
 * Resolve `git`/`gh` to a trusted ABSOLUTE path, refusing any binary that resolves
 * INSIDE the reviewed tree. Every git/gh spawn goes through this, never a bare name.
 *
 * A review has chdir'd into the untrusted PR-head tree (and `ecr review` of a local
 * branch, plus `ecr ci`/doctor, operate on an untrusted checkout). libuv on Windows
 * searches the child's cwd BEFORE PATH when the command is a BARE NAME, so a
 * PR-committed `git.bat`/`gh.exe` at the repo root would win the lookup and run with
 * ambient secrets (GH_TOKEN, model creds) in its environment. Spawning a resolved
 * absolute path does no cwd search at all — the same property that fixed `claude`
 * and `opencode`. resolveOnPath itself does the which/where lookup from tmpdir(), so
 * the in-tree shim is never even FOUND on POSIX or Windows; pathInside is the backstop.
 *
 * Memoized per name: resolveOnPath is cwd-INDEPENDENT (it looks up from tmpdir), so a
 * first call can never cache a cwd-tainted value, and the host binary is stable for
 * the process. The caller's cwd is NOT changed — only the binary is resolved, so
 * git/gh keep operating on their target tree. Throws (not null) so callers that
 * assume a working git/gh fail loudly rather than silently spawning nothing.
 */
export function resolveTrustedTool(name: "git" | "gh"): Promise<string> {
  let resolution = trustedToolResolutions.get(name);
  if (!resolution) {
    resolution = (async () => {
      const resolved = await resolveOnPath(name);
      if (!resolved) {
        throw new Error(`The \`${name}\` CLI is not installed or not on PATH.`);
      }
      if (pathInside(resolved, process.cwd())) {
        throw new Error(
          `refusing to run a \`${name}\` binary found inside the reviewed tree (${resolved}) — ` +
            `install ${name} on the host and remove it from the repository.`,
        );
      }
      return resolved;
    })();
    trustedToolResolutions.set(name, resolution);
  }
  return resolution;
}

/** Test-only: drop memoized git/gh resolutions so a test can re-resolve under a changed cwd/PATH. */
export function resetTrustedToolCache(): void {
  trustedToolResolutions.clear();
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const gitPath = await resolveTrustedTool("git");
  const { stdout } = await run(gitPath, args, { cwd });
  return stdout;
}

/** Resolve owner/repo from the current checkout via gh (for PR-targeting commands). */
export async function resolveRepo(cwd?: string): Promise<string> {
  try {
    const gh = await resolveTrustedTool("gh");
    const { stdout } = await run(
      gh,
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      {
        cwd,
      },
    );
    const repo = stdout.trim();
    if (repo) {
      return repo;
    }
  } catch {
    // fall through to a clear error
  }
  throw new Error("Could not determine the repository; pass --repo owner/repo.");
}

/** Absolute path of the git working-tree root, or null if not in a repo. */
export async function repoRoot(cwd?: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim() || null;
  } catch {
    return null;
  }
}

/** Absolute path of an executable on PATH (first match), or null if unresolved. */
export async function resolveOnPath(command: string): Promise<string | null> {
  // SECURITY: run the lookup from a trusted directory, never the inherited cwd.
  // During a review the process has chdir'd into the untrusted PR-head tree, and
  // Windows `where` searches the CURRENT DIRECTORY before PATH — a committed
  // `claude.exe` at the repo root would win the lookup and be executed with the
  // engine's credentials in its environment. tmpdir() is host-controlled.
  const { stdout, code } = await run(process.platform === "win32" ? "where" : "which", [command], {
    check: false,
    cwd: tmpdir(),
  });
  if (code !== 0) {
    return null;
  }
  return stdout.trim().split("\n")[0]?.trim() || null;
}

/**
 * Whether `filePath` lies inside `dir` (after resolution). Used as the backstop
 * that refuses to execute a binary resolved from inside the reviewed tree.
 */
export function pathInside(filePath: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Absolute path to Windows' `taskkill`, so a process-tree kill never spawns a BARE
 * `taskkill` — during a review the cwd is the untrusted PR-head tree, and Windows
 * resolves a bare name against the current directory before PATH, so a PR-committed
 * `taskkill.exe`/`.bat` at the tree root could otherwise run in place of the real one
 * (with ambient secrets in its env) on the timeout-kill path. An absolute path does no
 * search at all. `taskkill` always lives in System32, and `SystemRoot` is set by
 * Windows, never by the PR. Callers stay win32-guarded.
 */
export function taskkillPath(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", "taskkill.exe");
}

/** Whether an executable is resolvable on PATH. */
export async function onPath(command: string): Promise<boolean> {
  return (await resolveOnPath(command)) !== null;
}
