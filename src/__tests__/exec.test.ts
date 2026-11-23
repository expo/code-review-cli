import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChildProcess } from "node:child_process";

import { expect, test } from "bun:test";

import {
  git,
  resetTrustedToolCache,
  resolveOnPath,
  resolveTrustedTool,
  run,
  spawnPiped,
  taskkillPath,
} from "../core/exec.js";

test("run with input: feeds stdin through the spawn path", async () => {
  const result = await run("cat", [], { input: "hello stdin" });
  expect(result.stdout).toBe("hello stdin");
  expect(result.code).toBe(0);
  expect(result.timedOut).toBeFalsy();
  expect(result.overflowed).toBeFalsy();
});

test("run with input: observes admitted stdout incrementally without changing capture", async () => {
  const observed: string[] = [];
  const result = await run("sh", ["-c", "printf first; sleep 0.05; printf second"], {
    input: "",
    onStdout: (chunk) => observed.push(chunk),
  });
  expect(result.stdout).toBe("firstsecond");
  expect(observed.join("")).toBe(result.stdout);
});

test("run with input: a stdout observer failure never breaks the command", async () => {
  const result = await run("printf", ["safe"], {
    input: "",
    onStdout: () => {
      throw new Error("observer failed");
    },
  });
  expect(result.stdout).toBe("safe");
  expect(result.code).toBe(0);
});

test("run with input: timeout kills the child and resolves timedOut (no throw)", async () => {
  const started = Date.now();
  const result = await run("sleep", ["30"], { input: "", timeout: 250, check: true });
  expect(result.timedOut).toBe(true);
  // The kill fired at the deadline, not after the child's own 30s.
  expect(Date.now() - started).toBeLessThan(10_000);
});

/**
 * Wait until `pid` no longer names a LIVE process. `kill(pid, 0)` alone is racy
 * here: it still succeeds while the killed grandchild is a zombie awaiting init's
 * reap (the direct `sh` dies first, the orphaned `sleep` reparents, and reaping is
 * asynchronous) — which is exactly what flaked on loaded CI runners. A zombie is
 * dead for this test's purpose, so a `ps` state of `Z` (or no row) counts as gone.
 * A process that genuinely survived the group kill (`sleep 30`) outlives the whole
 * poll window and still fails the assertion.
 */
async function processGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH: fully gone
    }
    const state = (
      await run("ps", ["-o", "state=", "-p", String(pid)], { check: false })
    ).stdout.trim();
    if (state === "" || state.startsWith("Z")) {
      return true; // reaped between the two checks, or dead-but-unreaped
    }
    if (Date.now() - started >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("run with input: timeout kills the whole process group, not just the direct child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-test-"));
  const pidFile = join(dir, "grandchild.pid");
  try {
    const result = await run("sh", ["-c", `sleep 30 & echo $! >"${pidFile}"; wait`], {
      input: "",
      timeout: 250,
      check: true,
    });
    expect(result.timedOut).toBe(true);
    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    // If only the direct `sh` had been signaled, this grandchild `sleep 30` would
    // still be alive well past the poll window; the group kill leaves it dead (or
    // momentarily zombie) within milliseconds.
    expect(await processGone(grandchildPid)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

test("run with input: escalates to SIGKILL after the grace period when the child traps SIGTERM", async () => {
  const started = Date.now();
  // The deadline timer starts at spawn, so the child must have SIGTERM ignored
  // before it fires or the default disposition kills it and this never reaches
  // the escalation path. `sh` with an ignoring `trap` is the cheapest way there:
  // it boots in ~1ms (a node runtime takes far longer, and lost this race on a
  // loaded CI runner), and an *ignored* signal survives `exec` where an
  // installed handler would not — so the `sleep` holding the group ignores it too.
  const result = await run("sh", ["-c", 'trap "" TERM; exec sleep 30'], {
    input: "",
    timeout: 1000,
    check: true,
  });
  expect(result.timedOut).toBe(true);
  // SIGTERM alone never ends a process that ignores it; only the 5s grace-timer
  // SIGKILL escalation does, so a duration past that proves the path fired.
  expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
  expect(Date.now() - started).toBeLessThan(14_000);
}, 20_000);

test("run without input: timeout resolves timedOut too (execFile path, same contract)", async () => {
  const started = Date.now();
  const result = await run("sleep", ["30"], { timeout: 250, check: true });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("run with input: maxBuffer overflow is flagged, not silently truncated", async () => {
  let observed = "";
  const result = await run("sh", ["-c", "head -c 100000 /dev/zero | tr '\\0' 'x'"], {
    input: "",
    maxBuffer: 1024,
    check: false,
    onStdout: (chunk) => {
      observed += chunk;
    },
  });
  expect(result.overflowed).toBe(true);
  expect(observed.length).toBe(1024);
});

test("run with input: check=false returns a non-zero exit instead of throwing", async () => {
  const result = await run("sh", ["-c", "echo out; echo err >&2; exit 3"], {
    input: "",
    check: false,
  });
  expect(result.code).toBe(3);
  expect(result.stdout).toBe("out\n");
  expect(result.stderr).toBe("err\n");
});

test("run with input: check=true throws on a non-zero exit", async () => {
  await expect(run("sh", ["-c", "exit 2"], { input: "" })).rejects.toThrow(/Command failed/);
});

test("run with input: a custom env is passed to the child", async () => {
  const result = await run("sh", ["-c", 'printf %s "$ECR_EXEC_TEST"'], {
    input: "",
    env: { PATH: process.env.PATH, ECR_EXEC_TEST: "forwarded" },
  });
  expect(result.stdout).toBe("forwarded");
});

test("should write stdout to a file when stdoutPath is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-stdout-"));
  const file = join(dir, "out.txt");
  try {
    // The child sees a regular file, so it is not a pipe that a fast exit can cut short.
    const result = await run("/bin/sh", ["-c", "[ -f /dev/stdout ] && printf whole"], {
      stdoutPath: file,
    });
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(await readFile(file, "utf8")).toBe("whole");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("should stop the process group at the timeout when stdoutPath is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-stdout-"));
  const started = Date.now();
  try {
    const result = await run("/bin/sh", ["-c", "sleep 30 & wait"], {
      stdoutPath: join(dir, "out.txt"),
      timeout: 100,
      check: false,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveOnPath: absolute path for a real command, null for a fake one", async () => {
  const sh = await resolveOnPath("sh");
  expect(sh).not.toBeNull();
  expect(sh!.startsWith("/")).toBe(true);
  expect(await resolveOnPath("definitely-not-a-real-command-ecr")).toBeNull();
});

test("resolveTrustedTool: resolves git to an absolute path, memoized to one lookup", async () => {
  resetTrustedToolCache();
  const first = resolveTrustedTool("git");
  // The SAME promise is returned for a repeated call, so the many git()/gh callers
  // share one which/where lookup instead of each spawning their own.
  expect(resolveTrustedTool("git")).toBe(first);
  const gitPath = await first;
  expect(isAbsolute(gitPath)).toBe(true);
});

test("resolveTrustedTool: refuses (throws on) a binary that resolves inside the reviewed tree", async () => {
  // realpath so the dir has no /var→/private/var symlink to defeat the in-tree check.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ecr-trusted-intree-")));
  const bin = join(dir, "gh");
  await writeFile(bin, `#!/bin/sh\necho hijacked\n`, "utf8");
  await chmod(bin, 0o755);
  const savedPath = process.env.PATH;
  const savedCwd = process.cwd();
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
  process.chdir(dir); // cwd now CONTAINS the fake gh → in-tree
  resetTrustedToolCache();
  try {
    // resolveOnPath finds dir/gh (from tmpdir), pathInside refuses it → a throw, so a
    // PR-committed shim is never spawned with ambient secrets in its env.
    await expect(resolveTrustedTool("gh")).rejects.toThrow(/reviewed tree/);
  } finally {
    process.chdir(savedCwd);
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    resetTrustedToolCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("git: spawns the resolved absolute path, never a bare `git`", async () => {
  // A fake git that reports how it was invoked ($0). cwd stays the repo root (out of
  // this temp dir), so the fake is on PATH but NOT in-tree — resolved, not refused.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ecr-trusted-git-")));
  const bin = join(dir, "git");
  await writeFile(bin, `#!/bin/sh\nprintf '%s' "$0"\n`, "utf8");
  await chmod(bin, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
  resetTrustedToolCache();
  try {
    const argv0 = (await git(["rev-parse"], dir)).trim();
    // The absolute resolved path reached the child, not a bare "git" (which libuv
    // would resolve against the child cwd on Windows).
    expect(argv0).toBe(bin);
    expect(argv0).not.toBe("git");
  } finally {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    resetTrustedToolCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("taskkillPath: an absolute System32 path, never a bare `taskkill`", () => {
  const saved = process.env.SystemRoot;
  try {
    process.env.SystemRoot = "C:\\Windows";
    const resolved = taskkillPath();
    // A bare name would let libuv resolve it against the untrusted cwd on Windows; an
    // absolute path does no search at all.
    expect(resolved).not.toBe("taskkill");
    expect(resolved.replace(/\\/g, "/")).toBe("C:/Windows/System32/taskkill.exe");
  } finally {
    if (saved === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = saved;
    }
  }
});

test("should stop the children of spawnPiped and spawnInherited when the parent gets SIGTERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-test-"));
  const script = join(dir, "parent.ts");
  const execModule = fileURLToPath(new URL("../core/exec.ts", import.meta.url));
  await writeFile(
    script,
    `import { spawnInherited, spawnPiped } from ${JSON.stringify(execModule)};\n` +
      `const server = spawnPiped("sleep", ["300"]);\n` +
      `console.log("server=" + server.pid);\n` +
      `await spawnInherited("sh", ["-c", "echo tui=$$; exec sleep 300"]);\n`,
  );
  const parent = spawnPiped(process.execPath, [script]);
  const pids: number[] = [];
  try {
    let output = "";
    const children = await new Promise<{ server: number; tui: number }>((resolve, reject) => {
      parent.once("exit", () => reject(new Error(`the parent exited early: ${output}`)));
      parent.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        const server = /^server=(\d+)$/m.exec(output);
        const tui = /^tui=(\d+)$/m.exec(output);
        if (server && tui) {
          resolve({ server: Number(server[1]), tui: Number(tui[1]) });
        }
      });
    });
    pids.push(children.server, children.tui);
    parent.kill("SIGTERM");
    expect(await processGone(children.server)).toBe(true);
    expect(await processGone(children.tui)).toBe(true);
  } finally {
    parent.kill("SIGKILL");
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("should run each cleanup that was not cancelled when the process gets SIGTERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-test-"));
  const script = join(dir, "parent.ts");
  const removed = join(dir, "removed");
  const kept = join(dir, "kept");
  const execModule = fileURLToPath(new URL("../core/exec.ts", import.meta.url));
  await mkdir(removed);
  await mkdir(kept);
  await writeFile(
    script,
    `import { rmSync } from "node:fs";\n` +
      `import { runAtExit } from ${JSON.stringify(execModule)};\n` +
      `runAtExit(() => { throw new Error("this cleanup fails"); });\n` +
      `runAtExit(() => rmSync(${JSON.stringify(removed)}, { recursive: true }));\n` +
      `runAtExit(() => rmSync(${JSON.stringify(kept)}, { recursive: true }))();\n` +
      `console.log("ready");\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const parent = spawnPiped(process.execPath, [script]);
  try {
    const exited = new Promise<number | null>((resolve) => parent.once("exit", resolve));
    await Promise.race([
      new Promise((resolve) => parent.stdout?.once("data", resolve)),
      exited.then((code) => Promise.reject(new Error(`the parent exited early: ${code}`))),
    ]);
    parent.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  } finally {
    parent.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/**
 * Start a parent process that runs `body` with exec.ts imported as `exec`.
 * Resolves with the pid the parent prints as `<name>=<pid>`.
 */
async function startParent(
  dir: string,
  body: string,
  name: string,
): Promise<{ parent: ChildProcess; pid: number }> {
  const script = join(dir, "parent.ts");
  const execModule = fileURLToPath(new URL("../core/exec.ts", import.meta.url));
  await writeFile(script, `import * as exec from ${JSON.stringify(execModule)};\n${body}\n`);
  const parent = spawnPiped(process.execPath, [script]);
  let output = "";
  const pid = await new Promise<number>((resolve, reject) => {
    parent.once("exit", () => reject(new Error(`the parent exited early: ${output}`)));
    parent.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const match = new RegExp(`^${name}=(\\d+)$`, "m").exec(output);
      if (match) {
        resolve(Number(match[1]));
      }
    });
  });
  return { parent, pid };
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test("should kill a child that ignores SIGTERM after the grace period", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-test-"));
  const { parent, pid } = await startParent(
    dir,
    `await exec.spawnInherited("sh", ["-c", "trap '' TERM; echo tui=$$; while :; do sleep 1; done"]);`,
    "tui",
  );
  try {
    parent.kill("SIGTERM");
    // It is still there during the grace period, and gone after it.
    expect(await processGone(pid, 1000)).toBe(false);
    expect(await processGone(pid, 8000)).toBe(true);
  } finally {
    parent.kill("SIGKILL");
    killQuietly(pid);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("should stop the commands that a spawnPiped child started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-test-"));
  const { parent, pid } = await startParent(
    dir,
    `const server = exec.spawnPiped("sh", ["-c", "sleep 300 & echo worker=$!; wait"]);\n` +
      `server.stdout?.pipe(process.stdout);\n` +
      `setInterval(() => {}, 1000);`,
    "worker",
  );
  try {
    parent.kill("SIGTERM");
    expect(await processGone(pid)).toBe(true);
  } finally {
    parent.kill("SIGKILL");
    killQuietly(pid);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("should run the cleanups after the children have stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecr-exec-test-"));
  const seen = join(dir, "seen");
  const { parent, pid } = await startParent(
    dir,
    `import { writeFileSync } from "node:fs";\n` +
      // This child needs half a second to stop.
      `const child = exec.spawnPiped("sh", ["-c", "trap 'sleep 0.5; exit 0' TERM; echo child=$$; while :; do sleep 0.1; done"]);\n` +
      `exec.runAtExit(() => {\n` +
      `  let state = "gone";\n` +
      `  try { process.kill(child.pid!, 0); state = "running"; } catch {}\n` +
      `  writeFileSync(${JSON.stringify(seen)}, state);\n` +
      `});\n` +
      `child.stdout?.pipe(process.stdout);\n` +
      `setInterval(() => {}, 1000);`,
    "child",
  );
  try {
    const exited = new Promise<number | null>((resolve) => parent.once("exit", resolve));
    parent.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(await readFile(seen, "utf8")).toBe("gone");
  } finally {
    parent.kill("SIGKILL");
    killQuietly(pid);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
