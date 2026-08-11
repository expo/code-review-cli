#!/usr/bin/env node
// @ref LLP 0013#one-package-two-binaries [implements] — the environment boundary the engine's MCP config cannot provide
/**
 * Environment boundary for the bounded documentation MCP.
 *
 * ECR declares a minimal `env` in the engine's MCP configuration, but neither
 * engine treats that as a replacement: Claude Code and OpenCode both MERGE it
 * onto the environment the engine already holds. Verified by spawning each
 * engine against a probe MCP that records variable names — the child saw the
 * engine's model credential on both, and OpenCode additionally passed through
 * the runner's whole ambient environment.
 *
 * So the boundary has to be ours. The engine spawns this wrapper; the wrapper
 * spawns the real server with an environment it CONSTRUCTS. Whatever the engine
 * merged in reaches this process and stops here.
 *
 * This file deliberately does almost nothing. It loads no HTML/JSON parser and
 * opens no socket, because it is the one process in the chain that still holds
 * the engine's credentials. Everything that touches untrusted remote content
 * runs in the child, which never receives them.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

import { researchWrapperEnvironment } from "./child-env.js";

const builtEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
const sourceEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));

const child = spawn(
  // The current interpreter by absolute path, never a PATH lookup: during a
  // review the cwd is the untrusted PR-head tree.
  process.execPath,
  [existsSync(builtEntry) ? builtEntry : sourceEntry, ...process.argv.slice(2)],
  {
    env: researchWrapperEnvironment(process.env),
    // The child owns the engine's stdio directly, so the wrapper never sits in
    // the MCP byte stream and cannot truncate, buffer, or reorder a message.
    stdio: "inherit",
  },
);

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of FORWARDED_SIGNALS) {
  // The engine signals the process it spawned — us. Pass it on, or the server
  // outlives the review and keeps its audit lock.
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error: Error) => {
  process.stderr.write(`review-research-mcp: failed to start bounded server: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  // Report a signal death as the conventional 128+n rather than a silent 0, so a
  // killed server is distinguishable from a clean shutdown.
  process.exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1);
});
