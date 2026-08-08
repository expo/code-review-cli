#!/usr/bin/env node
// @ref LLP 0013#one-package-two-binaries [implements] — the package's second binary serves the bounded MCP
// @ref LLP 0013#search-fetch-and-optional-index-boundary [implements] — live discovery is the only evidence path

import { runStdioServer } from "./server.js";

function printHelp() {
  process.stdout.write(`review-research-mcp

Usage:
  review-research-mcp [serve]

The serve command uses BRAVE_SEARCH_API_KEY for scoped web discovery and fetches only
allowlisted official pages. Expo-provider searches use Expo's public documentation
index. Its fetch_platform_doc tool can fetch one exact allowlisted documentation URL
without a search key and return focused, section, or bounded-document extracted
context.
`);
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function main() {
  const [command = "serve", ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "serve") {
    if (rest.includes("--help") || rest.includes("-h")) {
      printHelp();
      return;
    }
    if (rest.length > 0) {
      throw new Error(`Unexpected argument: ${rest[0]}`);
    }
    await runStdioServer({
      ...(process.env.REVIEW_RESEARCH_AUDIT_PATH
        ? { auditPath: process.env.REVIEW_RESEARCH_AUDIT_PATH }
        : {}),
      maxCalls: boundedInteger("REVIEW_RESEARCH_MAX_CALLS", 8, 1, 20),
      maxResultsPerCall: boundedInteger("REVIEW_RESEARCH_MAX_RESULTS", 3, 1, 3),
      timeoutMs: boundedInteger("REVIEW_RESEARCH_TIMEOUT_MS", 30_000, 1_000, 60_000),
      ...(process.env.BRAVE_SEARCH_API_KEY
        ? { braveApiKey: process.env.BRAVE_SEARCH_API_KEY }
        : {}),
    });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`review-research-mcp: ${message}\n`);
  process.exitCode = 1;
});
