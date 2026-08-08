// Shared runner for the research evaluation scripts.
//
// Default mode replays recorded fixtures (no network, no key) and validates
// the full MCP pipeline deterministically. Set RESEARCH_EVAL_LIVE=1 (plus
// BRAVE_SEARCH_API_KEY) to run the same cases against live search instead.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createDocumentationServer } from "../../build/research-mcp/server.js";
import { createRecordedFetch } from "./recorded-fetch.mjs";

const INDEX_PATH = fileURLToPath(new URL("../../research/data/docs-index.json", import.meta.url));

async function callSearch(serverOptions, name, args) {
  // One server per case keeps every case inside the per-server call budget.
  const server = await createDocumentationServer(serverOptions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const response = await client.callTool({ name: "search_platform_docs", arguments: args });
    const block = response.content.find((entry) => entry.type === "text");
    return JSON.parse(block?.text ?? "{}");
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Run every case and report PASS/FAIL per line. Returns the failure count and
 * sets a nonzero exit code when any case fails, without stopping at the first.
 */
export async function runEvalCases(cases, { clientName, buildArguments, assertCase }) {
  const live = process.env.RESEARCH_EVAL_LIVE === "1";
  const serverOptions = live
    ? {
        ...(process.env.BRAVE_SEARCH_API_KEY
          ? { braveApiKey: process.env.BRAVE_SEARCH_API_KEY }
          : {}),
        ...(existsSync(INDEX_PATH) ? { indexPath: INDEX_PATH } : {}),
      }
    : { fetchImplementation: createRecordedFetch(cases), braveApiKey: "recorded-fixtures" };

  let failures = 0;
  for (const testCase of cases) {
    try {
      const payload = await callSearch(serverOptions, clientName, buildArguments(testCase));
      const failure = assertCase(testCase, payload.results ?? [], payload);
      if (failure) {
        failures++;
        console.log(`FAIL ${testCase.label} | ${failure}`);
      } else {
        console.log(`PASS ${testCase.label} | ${testCase.query}`);
      }
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${testCase.label} | tool call failed: ${message}`);
    }
  }
  console.log(
    `${cases.length - failures}/${cases.length} cases passed (${live ? "live" : "recorded"} mode)`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
  return failures;
}

/** Standard assertion: a result URL contains the expected substring (or none exist). */
export function assertExpectedUrl(testCase, results) {
  if (testCase.empty) {
    return results.length === 0 ? undefined : `expected an honest empty result, got ${results.length}`;
  }
  const expected = testCase.expected ?? testCase.url;
  const match = results.find((result) => result.url.includes(expected));
  if (!match) {
    const seen = results.map((result) => result.url).join(", ") || "(none)";
    return `expected a result URL containing ${expected}; got ${seen}`;
  }
  if (testCase.sourceKind && match.sourceKind !== testCase.sourceKind) {
    return `expected sourceKind ${testCase.sourceKind}; got ${match.sourceKind}`;
  }
  if (testCase.providers?.length === 1 && match.provider !== testCase.providers[0]) {
    return `expected provider ${testCase.providers[0]}; got ${match.provider}`;
  }
  return undefined;
}
