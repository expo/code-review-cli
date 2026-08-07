#!/usr/bin/env node
// @ref LLP 0013#one-package-two-binaries [implements] — the package's second binary owns serve/update dispatch
// @ref LLP 0013#search-fetch-and-optional-index-boundary [implements] — review-facing serve and operator-only update stay separate

import { parseArgs } from "node:util";

import { defaultConfigPath } from "./paths.js";
import { runStdioServer } from "./server.js";
import { PLATFORMS, type Platform } from "./types.js";

function printHelp() {
  process.stdout.write(`review-research-mcp

Usage:
  review-research-mcp [serve]
  review-research-mcp serve [--index PATH]
  review-research-mcp update [--config PATH] [--output PATH]
                             [--platform apple|android|react-native] [--max-pages NUMBER]

The serve command uses BRAVE_SEARCH_API_KEY for scoped web discovery, fetches only
allowlisted official pages, and optionally falls back to a local index. Expo-provider
searches use Expo's public documentation index. The update command is an optional
offline crawler for operator-managed fallback indexes.
`);
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
    const { values } = parseArgs({
      args: rest,
      options: {
        index: { type: "string" },
      },
      strict: true,
    });
    const indexPath = values.index ?? process.env.REVIEW_RESEARCH_INDEX_PATH;
    await runStdioServer({
      ...(indexPath ? { indexPath } : {}),
      ...(process.env.BRAVE_SEARCH_API_KEY
        ? { braveApiKey: process.env.BRAVE_SEARCH_API_KEY }
        : {}),
    });
    return;
  }

  if (command === "update") {
    if (rest.includes("--help") || rest.includes("-h")) {
      printHelp();
      return;
    }
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: "string" },
        output: { type: "string" },
        platform: { type: "string", multiple: true },
        "max-pages": { type: "string" },
      },
      strict: true,
    });
    const invalidPlatform = values.platform?.find(
      (platform) => !PLATFORMS.includes(platform as Platform),
    );
    if (invalidPlatform) {
      throw new Error(`Unknown platform: ${invalidPlatform}`);
    }
    const maxPages = values["max-pages"] ? Number(values["max-pages"]) : undefined;
    if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
      throw new Error("--max-pages must be a positive integer");
    }

    const { updateDocumentationIndex } = await import("./crawler.js");
    const result = await updateDocumentationIndex({
      configPath: values.config ?? defaultConfigPath,
      ...(values.output ? { outputPath: values.output } : {}),
      ...(values.platform ? { platforms: values.platform as Platform[] } : {}),
      ...(maxPages ? { maxPagesPerProvider: maxPages } : {}),
    });
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`review-research-mcp: ${message}\n`);
  process.exitCode = 1;
});
