import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The only test that drives the real stdio binary, so it owns the tool-metadata
// contract: names, annotations, and the schemas a model actually reads.
test("stdio MCP advertises the read-only documentation tools and their enforced bounds", async () => {
  const cliPath = fileURLToPath(new URL("../../research-mcp/cli.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve"],
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
    expect(searchTool?.description ?? "").toContain(
      "apple-releases=Xcode and Apple platform release notes",
    );
    expect(searchTool?.description ?? "").toContain("media3=Jetpack Media3");
    expect(searchTool?.description ?? "").toContain(
      "sdwebimage=SDWebImage APIs and caching/loading behavior",
    );
    expect(searchTool?.description ?? "").toContain("Native source retains platform context");
    expect(searchTool?.description ?? "").toContain("react-native-worklets=Worklets");
    expect(fetchTool?.annotations?.readOnlyHint).toBe(true);
    expect(fetchTool?.description ?? "").toMatch(/every redirect/);
    const inputSchema = searchTool?.inputSchema as {
      properties?: {
        query?: { description?: string };
        providers?: { description?: string };
      };
    };
    const fetchInputSchema = fetchTool?.inputSchema as {
      properties?: { context?: { default?: string; description?: string } };
    };
    expect(inputSchema.properties?.query?.description ?? "").toMatch(
      /CameraView barcodeScannerSettings/,
    );
    expect(inputSchema.properties?.providers?.description ?? "").toContain(
      "agp=Android Gradle Plugin",
    );
    expect(inputSchema.properties?.providers?.description ?? "").toContain(
      "jetbrains-issues=JetBrains YouTrack context",
    );
    expect(fetchInputSchema.properties?.context?.default).toBe("section");
    expect(fetchInputSchema.properties?.context?.description ?? "").toContain(
      "document=bounded extracted page text",
    );
    // The advertised search limit is the limit the server enforces.
    const searchInputSchema = searchTool?.inputSchema as
      | { properties?: { limit?: { maximum?: number; default?: number } } }
      | undefined;
    expect(searchInputSchema?.properties?.limit?.maximum).toBe(3);
    expect(searchInputSchema?.properties?.limit?.default).toBe(3);
  } finally {
    await client.close();
  }
});

test("stdio MCP reports unavailable remote discovery honestly", async () => {
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
      retrieval: {
        scopedWebSearch: boolean;
        network: Record<string, number>;
      };
      warnings: string[];
      results: unknown[];
    };
    expect(payload.retrieval).toMatchObject({
      scopedWebSearch: false,
      expoSearch: false,
    });
    // No key and no provider reachable, so the call must not have touched the network.
    expect(payload.retrieval.network).toMatchObject({
      searchRequests: 0,
      documentRequests: 0,
      redirects: 0,
      totalRequests: 0,
    });
    expect(payload.warnings[0]).toMatch(/BRAVE_SEARCH_API_KEY is not set/);
    expect(payload.results).toEqual([]);
  } finally {
    await client.close();
  }
});

test("stdio MCP rejects credential-shaped searches before network access, auditing only the reason class", async () => {
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
    // The refusal is audited by reason class only — never the rejected query text.
    const auditContents = await readFile(auditPath, "utf8");
    const events = auditContents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      {
        type: "rejected",
        tool: "search_platform_docs",
        reason: "query-rejected",
        timestamp: expect.any(String),
      },
    ]);
    expect(auditContents).not.toContain("ghp_");
    expect(auditContents).not.toContain("MainActor");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
