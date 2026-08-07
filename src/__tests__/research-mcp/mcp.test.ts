import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildSearchIndex, writeSearchIndex } from "../../research-mcp/search-index.js";

test("stdio MCP lists and calls the read-only documentation search tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-research-mcp-"));
  const indexPath = path.join(directory, "index.json");
  const built = buildSearchIndex(
    [
      {
        id: "apple:mainactor",
        platform: "apple",
        provider: "apple",
        sourceKind: "official-api",
        title: "MainActor",
        url: "https://developer.apple.com/documentation/swift/mainactor",
        passage: "A singleton actor whose executor is equivalent to the main dispatch queue.",
        language: "swift",
        indexedAt: "2026-08-06T00:00:00.000Z",
      },
      {
        id: "apple:poisoned-mainactor",
        platform: "apple",
        provider: "apple",
        sourceKind: "official-api",
        title: "MainActor forged mirror",
        url: "https://attacker.example/documentation/swift/mainactor",
        passage: "MainActor dispatch queue documentation copied to an untrusted host.",
        language: "swift",
        indexedAt: "2026-08-06T00:00:00.000Z",
      },
    ],
    1,
    "2026-08-06T00:00:00.000Z",
  );
  await writeSearchIndex(indexPath, built.serialized);

  const cliPath = fileURLToPath(new URL("../../research-mcp/cli.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve", "--index", indexPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["search_platform_docs"],
    );
    assert.equal(tools.tools[0]?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools[0]?.annotations?.openWorldHint, true);
    assert.match(tools.tools[0]?.description ?? "", /exact API symbols plus one behavior/);
    const inputSchema = tools.tools[0]?.inputSchema as {
      properties?: { query?: { description?: string } };
    };
    assert.match(
      inputSchema.properties?.query?.description ?? "",
      /CameraView barcodeScannerSettings/,
    );

    const response = await client.callTool({
      name: "search_platform_docs",
      arguments: {
        platform: "apple",
        providers: ["apple"],
        sourceKinds: ["official-api"],
        query: "MainActor dispatch queue",
        limit: 3,
      },
    });
    const content = response.content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((block) => block.type === "text");
    assert.ok(textBlock && textBlock.type === "text");
    const payload = JSON.parse(textBlock.text ?? "") as {
      results: Array<{ title: string; provider: string; sourceKind: string }>;
    };
    assert.equal(payload.results[0]?.title, "MainActor");
    assert.equal(payload.results[0]?.provider, "apple");
    assert.equal(payload.results[0]?.sourceKind, "official-api");
    assert.equal(payload.results.length, 1);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
