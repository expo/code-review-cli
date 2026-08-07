import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "search_platform_docs",
      "fetch_platform_doc",
    ]);
    const searchTool = tools.tools.find((tool) => tool.name === "search_platform_docs");
    const fetchTool = tools.tools.find((tool) => tool.name === "fetch_platform_doc");
    expect(searchTool?.annotations?.readOnlyHint).toBe(true);
    expect(searchTool?.annotations?.openWorldHint).toBe(true);
    expect(searchTool?.description ?? "").toMatch(/exact API symbols plus one behavior/);
    expect(fetchTool?.annotations?.readOnlyHint).toBe(true);
    expect(fetchTool?.description ?? "").toMatch(/every redirect/);
    const inputSchema = searchTool?.inputSchema as {
      properties?: { query?: { description?: string } };
    };
    expect(inputSchema.properties?.query?.description ?? "").toMatch(
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
    expect(textBlock?.type).toBe("text");
    const payload = JSON.parse(textBlock.text ?? "") as {
      results: Array<{ title: string; provider: string; sourceKind: string }>;
    };
    expect(payload.results[0]?.title).toBe("MainActor");
    expect(payload.results[0]?.provider).toBe("apple");
    expect(payload.results[0]?.sourceKind).toBe("official-api");
    expect(payload.results).toHaveLength(1);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdio MCP starts without an index and reports unavailable remote discovery honestly", async () => {
  const cliPath = fileURLToPath(new URL("../../research-mcp/cli.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve"],
    stderr: "pipe",
    env: {},
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "search_platform_docs",
      arguments: {
        platform: "apple",
        providers: ["apple"],
        query: "MainActor",
        limit: 1,
      },
    });
    const content = response.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(content.find((block) => block.type === "text")?.text ?? "") as {
      retrieval: { localIndex: unknown; scopedWebSearch: boolean };
      warnings: string[];
      results: unknown[];
    };
    expect(payload.retrieval).toEqual({
      scopedWebSearch: false,
      expoSearch: false,
      localIndex: null,
    });
    expect(payload.warnings[0]).toMatch(/BRAVE_SEARCH_API_KEY is not set/);
    expect(payload.results).toEqual([]);
  } finally {
    await client.close();
  }
});

test("stdio MCP rejects credential-shaped searches before network access or audit logging", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-research-mcp-secret-"));
  const auditPath = path.join(directory, "audit.jsonl");
  const cliPath = fileURLToPath(new URL("../../research-mcp/cli.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve"],
    stderr: "pipe",
    env: {
      REVIEW_RESEARCH_AUDIT_PATH: auditPath,
      BRAVE_SEARCH_API_KEY: "would-be-used-only-after-sanitization",
    },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "search_platform_docs",
      arguments: {
        platform: "apple",
        providers: ["apple"],
        query: "MainActor api_key=ghp_abcdefghijklmnopqrstuvwxyz",
        limit: 1,
      },
    });
    expect(response.isError).toBe(true);
    await expect(readFile(auditPath, "utf8")).rejects.toThrow();
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
