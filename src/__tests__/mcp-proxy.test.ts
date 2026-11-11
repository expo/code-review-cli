import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { readMcpServerUsage } from "../mcp-proxy/audit.js";
import {
  boundedOutput,
  createMcpProxyServer,
  fetchTokenVerdict,
  tokenInfoVerdict,
} from "../mcp-proxy/server.js";
import type { McpProxySettings, McpProxyUpstream, UpstreamResult } from "../mcp-proxy/server.js";

let root: string;
let settings: McpProxySettings;
const clients: Client[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ecr-mcp-proxy-"));
  settings = {
    name: "sandbox",
    url: "https://sandbox.example/mcp",
    tools: ["sandbox_exec"],
    extraTokenTools: [],
    maxCalls: 2,
    timeoutMs: 1_000,
    maxOutputBytes: 64,
    auditPath: path.join(root, "audit.jsonl"),
  };
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await rm(root, { recursive: true, force: true });
});

function upstreamWith(
  toolNames: string[],
  callTool: McpProxyUpstream["callTool"] = async () => ({
    content: [{ type: "text", text: "ok" }],
  }),
): McpProxyUpstream {
  return {
    listTools: async () =>
      toolNames.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
    callTool,
    close: async () => {},
  };
}

async function connect(
  upstream: McpProxyUpstream | (() => Promise<McpProxyUpstream>),
  overrides: Partial<McpProxySettings> = {},
): Promise<Client> {
  const server = createMcpProxyServer(
    { ...settings, ...overrides },
    typeof upstream === "function" ? upstream : async () => upstream,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function call(client: Client, name = "sandbox_exec", args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as UpstreamResult & {
    content: { type: string; text: string }[];
  };
  return { text: result.content[0]!.text, isError: result.isError === true };
}

test("should list and call a granted tool, with the output marked as untrusted", async () => {
  const client = await connect(upstreamWith(["sandbox_exec"]));
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["sandbox_exec"]);
  const result = await call(client);
  expect(result.isError).toBe(false);
  expect(result.text).toStartWith('The following text is output from the "sandbox" tool.');
  expect(result.text).toContain("untrusted data");
  expect(result.text).toEndWith("\n\nok");
});

test("should hide a tool the token may hold but no pass may call", async () => {
  const client = await connect(upstreamWith(["sandbox_exec", "destroy_sandbox"]), {
    extraTokenTools: ["destroy_sandbox"],
  });
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["sandbox_exec"]);
  const result = await call(client, "destroy_sandbox");
  expect(result.isError).toBe(true);
  expect(result.text).toContain("not granted");
});

test("should cut output at the byte limit and drop non-text parts", async () => {
  expect(boundedOutput([{ type: "text", text: "a".repeat(100) }], 10)).toEqual({
    text: `${"a".repeat(10)}\n[output cut at 10 bytes]`,
    bytes: 100,
    truncated: true,
  });
  expect(boundedOutput([{ type: "image", data: "AAAA" }], 64).text).toBe("[image content omitted]");
  expect(boundedOutput(undefined, 64).text).toBe("");
});

test("should refuse a server whose token offers tools the config does not name", async () => {
  let called = 0;
  const client = await connect(
    upstreamWith(["sandbox_exec", "github_create_pr"], async () => {
      called++;
      return {};
    }),
  );
  expect((await client.listTools()).tools).toEqual([]);
  const result = await call(client);
  expect(result.isError).toBe(true);
  expect(called).toBe(0);
  expect(await readMcpServerUsage(settings.auditPath)).toEqual([
    {
      server: "sandbox",
      calls: 0,
      errors: 0,
      truncated: 0,
      rejected: 0,
      refused: "token-too-broad",
      tools: {},
    },
  ]);
});

test("should serve no tools when the server is not reachable", async () => {
  const client = await connect(async () => {
    throw new Error("connect ECONNREFUSED https://sandbox.example/mcp");
  });
  expect((await client.listTools()).tools).toEqual([]);
  expect((await call(client)).isError).toBe(true);
  expect((await readMcpServerUsage(settings.auditPath))[0]!.refused).toBe("unavailable");
  expect(await readFile(settings.auditPath, "utf8")).not.toContain("ECONNREFUSED");
});

test("should share one call budget between the proxies of a run", async () => {
  const first = await connect(upstreamWith(["sandbox_exec"]));
  const second = await connect(upstreamWith(["sandbox_exec"]));
  expect((await call(first)).isError).toBe(false);
  expect((await call(second)).isError).toBe(false);
  const refused = await call(first);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("call budget");
  expect(await readMcpServerUsage(settings.auditPath)).toEqual([
    {
      server: "sandbox",
      calls: 2,
      errors: 0,
      truncated: 0,
      rejected: 1,
      tools: { sandbox_exec: 2 },
    },
  ]);
});

test("should end a call that passes its deadline", async () => {
  const client = await connect(
    upstreamWith(
      ["sandbox_exec"],
      (_name, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ),
    { timeoutMs: 20 },
  );
  const result = await call(client);
  expect(result.isError).toBe(true);
  expect(result.text).toContain("deadline");
  expect((await readMcpServerUsage(settings.auditPath))[0]!.errors).toBe(1);
});

test("should keep call arguments and output out of the audit", async () => {
  const client = await connect(
    upstreamWith(["sandbox_exec"], async () => ({
      content: [{ type: "text", text: "output-secret" }],
    })),
  );
  await call(client, "sandbox_exec", { command: "echo argument-secret" });
  const audit = await readFile(settings.auditPath, "utf8");
  expect(audit).not.toContain("argument-secret");
  expect(audit).not.toContain("output-secret");
  expect(audit).toContain('"argsSha256"');
});

test("should accept only a token the server calls scoped and not yet expired", () => {
  expect(tokenInfoVerdict({ scoped: true, expiresAt: 2_000 }, 1_000)).toBe("scoped");
  expect(tokenInfoVerdict({ scoped: false, expiresAt: 2_000 }, 1_000)).toBe("not-scoped");
  expect(tokenInfoVerdict({ scoped: true, expiresAt: null }, 1_000)).toBe("not-scoped");
  expect(tokenInfoVerdict({ scoped: true, expiresAt: 500 }, 1_000)).toBe("not-scoped");
  expect(tokenInfoVerdict({ scoped: "true", expiresAt: 2_000 }, 1_000)).toBe("not-scoped");
  expect(tokenInfoVerdict(null, 1_000)).toBe("not-scoped");
});

test("should send the token to the info url and refuse a redirect", async () => {
  let seen: RequestInit | undefined;
  const scoped = (async (_url: unknown, init?: RequestInit) => {
    seen = init;
    return Response.json({ scoped: true, expiresAt: Date.now() + 60_000 });
  }) as typeof fetch;
  expect(await fetchTokenVerdict("https://sandbox.example/tokens/info", "child", scoped)).toBe(
    "scoped",
  );
  expect(seen?.redirect).toBe("error");
  expect(new Headers(seen?.headers).get("Authorization")).toBe("Bearer child");
});

test("should not pass a token when the info url fails or no token is set", async () => {
  const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  const throwing = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  const url = "https://sandbox.example/tokens/info";
  expect(await fetchTokenVerdict(url, "child", failing)).toBe("unavailable");
  expect(await fetchTokenVerdict(url, "child", throwing)).toBe("unavailable");
  expect(await fetchTokenVerdict(url, undefined, throwing)).toBe("not-scoped");
});

test("should not connect to the server when its token is not scoped", async () => {
  let connected = 0;
  const server = createMcpProxyServer(
    settings,
    async () => {
      connected++;
      return upstreamWith(["sandbox_exec"]);
    },
    async () => "not-scoped",
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  expect((await client.listTools()).tools).toEqual([]);
  expect(connected).toBe(0);
  expect((await readMcpServerUsage(settings.auditPath))[0]!.refused).toBe("token-not-scoped");
});
