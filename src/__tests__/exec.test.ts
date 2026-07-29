import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { resolveOnPath, run } from "../core/exec.js";

test("run with input: feeds stdin through the spawn path", async () => {
  const result = await run("cat", [], { input: "hello stdin" });
  expect(result.stdout).toBe("hello stdin");
  expect(result.code).toBe(0);
  expect(result.timedOut).toBeFalsy();
  expect(result.overflowed).toBeFalsy();
});

test("run with input: timeout kills the child and resolves timedOut (no throw)", async () => {
  const started = Date.now();
  const result = await run("sleep", ["30"], { input: "", timeout: 250, check: true });
  expect(result.timedOut).toBe(true);
  // The kill fired at the deadline, not after the child's own 30s.
  expect(Date.now() - started).toBeLessThan(10_000);
});

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
    // If only the direct `sh` had been signaled, this detached grandchild `sleep`
    // would still be alive; process.kill throws ESRCH once the whole group is gone.
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run with input: escalates to SIGKILL after the grace period when the child traps SIGTERM", async () => {
  const started = Date.now();
  const result = await run(
    "node",
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { input: "", timeout: 250, check: true },
  );
  expect(result.timedOut).toBe(true);
  // SIGTERM alone never ends a process that traps it; only the 5s grace-timer
  // SIGKILL escalation does, so a duration past that proves the path fired.
  expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 10_000);

test("run without input: timeout resolves timedOut too (execFile path, same contract)", async () => {
  const started = Date.now();
  const result = await run("sleep", ["30"], { timeout: 250, check: true });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("run with input: maxBuffer overflow is flagged, not silently truncated", async () => {
  const result = await run("sh", ["-c", "head -c 100000 /dev/zero | tr '\\0' 'x'"], {
    input: "",
    maxBuffer: 1024,
    check: false,
  });
  expect(result.overflowed).toBe(true);
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

test("resolveOnPath: absolute path for a real command, null for a fake one", async () => {
  const sh = await resolveOnPath("sh");
  expect(sh).not.toBeNull();
  expect(sh!.startsWith("/")).toBe(true);
  expect(await resolveOnPath("definitely-not-a-real-command-ecr")).toBeNull();
});
