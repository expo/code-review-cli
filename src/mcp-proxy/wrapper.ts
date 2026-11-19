#!/usr/bin/env node
// @ref LLP 0003#configured-mcp-servers [implements] — the engine starts this wrapper, which starts the proxy with a built environment
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

import { mcpProxyChildEnvironment, settingsTokenEnv } from "./child-env.js";

const builtEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
const sourceEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));
const args = process.argv.slice(2);

let tokenEnv: string | undefined;
try {
  tokenEnv = args[0] ? settingsTokenEnv(readFileSync(args[0], "utf8")) : undefined;
} catch {
  // The proxy reads the same file and reports the error.
}

const child = spawn(
  // The current interpreter by absolute path: the cwd is the untrusted PR-head tree.
  process.execPath,
  [existsSync(builtEntry) ? builtEntry : sourceEntry, ...args],
  { env: mcpProxyChildEnvironment(process.env, tokenEnv), stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error: Error) => {
  process.stderr.write(`ecr-mcp-proxy: failed to start: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1);
});
