#!/usr/bin/env node
// @ref LLP 0003#configured-mcp-servers [implements] — the engine starts this proxy, never the remote server itself
import { readFile } from "node:fs/promises";

import { McpProxySettingsSchema, runStdioProxy } from "./server.js";

async function main(): Promise<void> {
  const [settingsPath, ...rest] = process.argv.slice(2);
  if (!settingsPath || rest.length > 0) {
    throw new Error("Usage: ecr-mcp-proxy <settings.json>");
  }
  const settings = McpProxySettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
  const token = settings.tokenEnv ? process.env[settings.tokenEnv] : undefined;
  if (settings.tokenEnv) {
    delete process.env[settings.tokenEnv];
  }
  await runStdioProxy(settings, token);
}

main().catch((error: unknown) => {
  // stdout is the MCP channel, so a failure goes to stderr only.
  process.stderr.write(`ecr-mcp-proxy: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 2;
});
