import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { McpProxyAudit, readMcpServerUsage, STALE_LOCK_MS } from "../mcp-proxy/audit.js";
import { mcpProxyChildEnvironment, settingsTokenEnv } from "../mcp-proxy/child-env.js";
import {
  boundedOutput,
  createMcpProxyServer,
  fetchTokenVerdict,
  listAllTools,
  MAX_TOOL_LIST_PAGES,
  McpProxySettingsSchema,
  tokenInfoVerdict,
  tokenRequirements,
} from "../mcp-proxy/server.js";
import type {
  McpProxySettings,
  McpProxyUpstream,
  UpstreamResult,
  UpstreamTool,
} from "../mcp-proxy/server.js";

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

test("should refuse a token that permits network access when the config forbids it", () => {
  const info = { scoped: true, expiresAt: 2_000 };
  const required = { noNetwork: true };
  expect(tokenInfoVerdict({ ...info, network: false }, 1_000, required)).toBe("scoped");
  expect(tokenInfoVerdict({ ...info, network: true }, 1_000, required)).toBe("not-scoped");
  expect(tokenInfoVerdict(info, 1_000, required)).toBe("not-scoped");
  expect(tokenInfoVerdict(info, 1_000)).toBe("scoped");
});

test("should refuse a token that keeps sudo when the config forbids it", () => {
  const info = { scoped: true, expiresAt: 2_000 };
  const required = { noSudo: true };
  expect(tokenInfoVerdict({ ...info, sudo: false }, 1_000, required)).toBe("scoped");
  expect(tokenInfoVerdict({ ...info, sudo: true }, 1_000, required)).toBe("not-scoped");
  // A server that does not know the limit leaves the field out.
  expect(tokenInfoVerdict(info, 1_000, required)).toBe("not-scoped");
  expect(tokenInfoVerdict({ ...info, sudo: "false" }, 1_000, required)).toBe("not-scoped");
  expect(tokenInfoVerdict(info, 1_000)).toBe("scoped");
});

test("should need each limit that the config asks for", () => {
  const info = { scoped: true, expiresAt: 2_000 };
  const required = { noNetwork: true, noSudo: true };
  expect(tokenInfoVerdict({ ...info, network: false, sudo: false }, 1_000, required)).toBe(
    "scoped",
  );
  expect(tokenInfoVerdict({ ...info, network: false }, 1_000, required)).toBe("not-scoped");
  expect(tokenInfoVerdict({ ...info, sudo: false }, 1_000, required)).toBe("not-scoped");
});

test("should read the limits from a settings file as the proxy parses it", () => {
  const parse = (extra: object) => McpProxySettingsSchema.parse({ ...settings, ...extra });
  expect(tokenRequirements(parse({ requireNoNetwork: true, requireNoSudo: true }))).toEqual({
    noNetwork: true,
    noSudo: true,
  });
  expect(tokenRequirements(parse({}))).toEqual({ noNetwork: false, noSudo: false });
});

test("should check the fetched token info against the limits", async () => {
  const answer = (info: object) =>
    (async () =>
      Response.json({
        scoped: true,
        expiresAt: Date.now() + 60_000,
        ...info,
      })) as unknown as typeof fetch;
  const url = "https://sandbox.example/tokens/info";
  const required = { noNetwork: true, noSudo: true };
  expect(
    await fetchTokenVerdict(url, "child", answer({ network: false, sudo: false }), required),
  ).toBe("scoped");
  expect(await fetchTokenVerdict(url, "child", answer({ network: false }), required)).toBe(
    "not-scoped",
  );
});

test("should cut output at a character boundary, never past the byte limit", () => {
  // "é" is two bytes, so a cut at 5 bytes falls inside the third one.
  const output = boundedOutput([{ type: "text", text: "éééé" }], 5);
  expect(output.truncated).toBe(true);
  expect(output.text).toBe("éé\n[output cut at 5 bytes]");
  expect(output.text).not.toContain("\uFFFD");
  const emoji = boundedOutput([{ type: "text", text: "😀😀" }], 6).text.split("\n")[0]!;
  expect(emoji).toBe("😀");
  expect(Buffer.byteLength(emoji, "utf8")).toBeLessThanOrEqual(6);
});

const tool = (name: string): UpstreamTool => ({ name, inputSchema: { type: "object" } });

test("should read every page of the tool list", async () => {
  const pages: Record<string, { tools: UpstreamTool[]; nextCursor?: string }> = {
    start: { tools: [tool("a")], nextCursor: "p2" },
    p2: { tools: [tool("b")], nextCursor: "p3" },
    p3: { tools: [tool("c")] },
  };
  const cursors: (string | undefined)[] = [];
  const tools = await listAllTools(async (cursor) => {
    cursors.push(cursor);
    return pages[cursor ?? "start"]!;
  });
  expect(tools.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  expect(cursors).toEqual([undefined, "p2", "p3"]);
});

test("should throw when the tool list repeats a cursor or has too many pages", async () => {
  await expect(
    listAllTools(async () => ({ tools: [tool("a")], nextCursor: "same" })),
  ).rejects.toThrow("repeated a cursor");
  let page = 0;
  await expect(
    listAllTools(async () => ({ tools: [tool("a")], nextCursor: `p${++page}` })),
  ).rejects.toThrow(`more than ${MAX_TOOL_LIST_PAGES} pages`);
  expect(page).toBe(MAX_TOOL_LIST_PAGES);
});

test("should refuse a server whose extra tool is on a later page of the list", async () => {
  const pages: Record<string, { tools: UpstreamTool[]; nextCursor?: string }> = {
    start: { tools: [tool("sandbox_exec")], nextCursor: "p2" },
    p2: { tools: [tool("github_create_pr")] },
  };
  const upstream: McpProxyUpstream = {
    listTools: () => listAllTools(async (cursor) => pages[cursor ?? "start"]!),
    callTool: async () => ({}),
    close: async () => {},
  };
  const client = await connect(upstream);
  expect((await client.listTools()).tools).toEqual([]);
  expect((await readMcpServerUsage(settings.auditPath))[0]!.refused).toBe("token-too-broad");
});

test("should serve no tools when the tool list never ends", async () => {
  const upstream: McpProxyUpstream = {
    listTools: () => listAllTools(async () => ({ tools: [tool("sandbox_exec")], nextCursor: "x" })),
    callTool: async () => ({}),
    close: async () => {},
  };
  const client = await connect(upstream);
  expect((await client.listTools()).tools).toEqual([]);
  expect((await readMcpServerUsage(settings.auditPath))[0]!.refused).toBe("unavailable");
});

test("should stop the remote call when the engine cancels it", async () => {
  let resolveSeen: (aborted: boolean) => void = () => {};
  const seen = new Promise<boolean>((resolve) => {
    resolveSeen = resolve;
  });
  let started: () => void = () => {};
  const callStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = await connect(
    upstreamWith(
      ["sandbox_exec"],
      (_name, _args, options) =>
        new Promise((_resolve, reject) => {
          started();
          options.signal.addEventListener("abort", () => {
            resolveSeen(true);
            reject(new Error("aborted"));
          });
        }),
    ),
    { timeoutMs: 60_000 },
  );
  const controller = new AbortController();
  const pending = client.callTool({ name: "sandbox_exec", arguments: {} }, undefined, {
    signal: controller.signal,
  });
  await callStarted;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(await seen).toBe(true);
});

test("should break an audit lock left by a killed proxy", async () => {
  const lockPath = `${settings.auditPath}.lock`;
  await mkdir(lockPath);
  const old = (Date.now() - STALE_LOCK_MS * 2) / 1000;
  await utimes(lockPath, old, old);
  const audit = new McpProxyAudit(settings.auditPath, "sandbox", 2);
  expect(await audit.reserve("sandbox_exec", 2, "hash")).toBe(true);
  expect((await readMcpServerUsage(settings.auditPath))[0]!.calls).toBe(1);
});

test("should share one budget between runs, and report each run's own calls", async () => {
  const first = new McpProxyAudit(settings.auditPath, "sandbox", 2, "scope-a");
  const second = new McpProxyAudit(settings.auditPath, "sandbox", 2, "scope-b");
  expect(await first.reserve("sandbox_exec", 2, "hash")).toBe(true);
  expect(await second.reserve("sandbox_exec", 2, "hash")).toBe(true);
  expect(await second.reserve("sandbox_exec", 2, "hash")).toBe(false);
  expect((await readMcpServerUsage(settings.auditPath, "scope-a"))[0]).toMatchObject({
    calls: 1,
    rejected: 0,
  });
  expect((await readMcpServerUsage(settings.auditPath, "scope-b"))[0]).toMatchObject({
    calls: 1,
    rejected: 1,
  });
  expect((await readMcpServerUsage(settings.auditPath))[0]!.calls).toBe(2);
});

test("should give the proxy only locale, network proxy and its own token", () => {
  const env = mcpProxyChildEnvironment(
    {
      PATH: "/usr/bin",
      GH_TOKEN: "gh",
      ANTHROPIC_API_KEY: "model",
      OTHER_SERVER_TOKEN: "other",
      REVIEW_SANDBOX_TOKEN: "sandbox",
      HTTPS_PROXY: "http://proxy:3128",
      NODE_OPTIONS: "--require evil.js",
    },
    "REVIEW_SANDBOX_TOKEN",
  );
  expect(env).toEqual({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HTTPS_PROXY: "http://proxy:3128",
    REVIEW_SANDBOX_TOKEN: "sandbox",
  });
  expect(mcpProxyChildEnvironment({ GH_TOKEN: "gh" }, undefined)).not.toHaveProperty("GH_TOKEN");
});

test("should read the token env name from the settings file, and nothing malformed", () => {
  expect(settingsTokenEnv(JSON.stringify({ tokenEnv: "REVIEW_SANDBOX_TOKEN" }))).toBe(
    "REVIEW_SANDBOX_TOKEN",
  );
  expect(settingsTokenEnv(JSON.stringify({ tokenEnv: "bad name" }))).toBeUndefined();
  expect(settingsTokenEnv("{not json")).toBeUndefined();
  expect(settingsTokenEnv("null")).toBeUndefined();
});
