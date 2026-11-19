import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_DIRNAME, loadReviewConfig } from "../config/load.js";
import { McpServerConfigSchema, ScopeReviewConfigSchema } from "../config/schema.js";
import type { McpServerConfig } from "../config/schema.js";
import {
  createMcpProxyRuntime,
  createSharedMcpAudit,
  mcpGrantEnvironment,
  mcpServerGrants,
  mcpServersForPullRequest,
  opencodeMcpTimeoutMs,
  opencodeMcpToolsOff,
} from "../core/mcp-servers.js";
import { promptAgent } from "../core/opencode.js";
import type { OpencodeHandle } from "../core/opencode.js";
import { RateLimitWatch } from "../core/throttle.js";

const SANDBOX: McpServerConfig = {
  url: "https://sandbox.example/mcp",
  tokenEnv: "REVIEW_SANDBOX_TOKEN",
  tools: ["create_sandbox", "sandbox_exec"],
  agents: ["deep", "verifier"],
  extraTokenTools: [],
  maxCalls: 20,
  timeoutMs: 120_000,
  maxOutputBytes: 16_384,
  requireNoNetwork: false,
  requireNoSudo: false,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ecr-mcp-servers-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRootConfig(config: unknown): Promise<void> {
  const dir = path.join(root, CONFIG_DIRNAME);
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await writeFile(path.join(dir, "config.jsonc"), JSON.stringify(config));
  await writeFile(path.join(dir, "coordinator.md"), "Coordinator.");
  await writeFile(path.join(dir, "agents", "deep.md"), "Deep.");
}

test("grants a server only to the agents it names, including the verifier", () => {
  const servers = { sandbox: SANDBOX };
  expect(mcpServerGrants(servers, "deep")).toEqual([
    { name: "sandbox", server: SANDBOX, tools: ["create_sandbox", "sandbox_exec"] },
  ]);
  expect(mcpServerGrants(servers, "verifier").map((grant) => grant.name)).toEqual(["sandbox"]);
  expect(mcpServerGrants(servers, "security")).toEqual([]);
  expect(mcpServerGrants(undefined, "deep")).toEqual([]);
});

test("points each engine at the local proxy and writes no token to disk", async () => {
  process.env.REVIEW_SANDBOX_TOKEN = "secret-value-that-must-not-be-written";
  const runtime = (await createMcpProxyRuntime({ sandbox: SANDBOX }))!;
  try {
    const file = runtime.claudeConfigPaths.get("sandbox")!;
    const text = await readFile(file, "utf8");
    const entry = JSON.parse(text).mcpServers.sandbox;
    expect(entry.type).toBe("stdio");
    expect([entry.command, ...entry.args]).toEqual(runtime.commands.get("sandbox")!);
    // The engine config holds no url and no token: only the proxy reaches the server.
    expect(text).not.toContain("sandbox.example");
    const settingsPath = entry.args.at(-1) as string;
    const settings = await readFile(settingsPath, "utf8");
    expect(JSON.parse(settings)).toMatchObject({
      name: "sandbox",
      url: "https://sandbox.example/mcp",
      tokenEnv: "REVIEW_SANDBOX_TOKEN",
      tools: ["create_sandbox", "sandbox_exec"],
      maxCalls: 20,
      auditPath: runtime.auditPath,
    });
    for (const written of [text, settings]) {
      expect(written).not.toContain("secret-value");
    }
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  } finally {
    delete process.env.REVIEW_SANDBOX_TOKEN;
    await runtime.cleanup();
  }
});

test("should pass the limits the token must have to the proxy", async () => {
  const read = async (server: McpServerConfig) => {
    const runtime = (await createMcpProxyRuntime({ sandbox: server }))!;
    try {
      const settingsPath = runtime.commands.get("sandbox")!.at(-1)!;
      return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    } finally {
      await runtime.cleanup();
    }
  };
  const tokenInfoUrl = "https://sandbox.example/tokens/info";
  expect(
    await read({ ...SANDBOX, tokenInfoUrl, requireNoNetwork: true, requireNoSudo: true }),
  ).toMatchObject({ tokenInfoUrl, requireNoNetwork: true, requireNoSudo: true });
  const plain = await read(SANDBOX);
  expect(plain).not.toHaveProperty("requireNoNetwork");
  expect(plain).not.toHaveProperty("requireNoSudo");
});

test("creates no proxy runtime when no server is available", async () => {
  expect(await createMcpProxyRuntime({})).toBeUndefined();
});

test("keeps every server for a pull request from the same repository", () => {
  const servers = { sandbox: SANDBOX };
  expect(mcpServersForPullRequest(servers, { fork: false, labels: [] })).toEqual(servers);
});

test("gives a fork pull request a server only with that server's fork label", () => {
  const labeled = { ...SANDBOX, forkLabel: "ai-review" };
  expect(
    mcpServersForPullRequest({ sandbox: labeled }, { fork: true, labels: ["ai-review"] }),
  ).toEqual({ sandbox: labeled });
  expect(mcpServersForPullRequest({ sandbox: labeled }, { fork: true, labels: ["bug"] })).toEqual(
    {},
  );
});

test("refuses a fork pull request when the server names no fork label", () => {
  expect(
    mcpServersForPullRequest({ sandbox: SANDBOX }, { fork: true, labels: ["ai-review"] }),
  ).toEqual({});
});

test("fills the call limits of a server that sets none", async () => {
  const { url, tokenEnv, tools, agents } = SANDBOX;
  await writeRootConfig({ mcpServers: { sandbox: { url, tokenEnv, tools, agents } } });
  expect((await loadReviewConfig(root)).mcpServers).toEqual({ sandbox: SANDBOX });
});

test("loads mcpServers from the root config", async () => {
  await writeRootConfig({ mcpServers: { sandbox: SANDBOX } });
  expect((await loadReviewConfig(root)).mcpServers).toEqual({ sandbox: SANDBOX });
});

test("refuses a plain http URL unless it points at this machine", async () => {
  await writeRootConfig({
    mcpServers: { sandbox: { ...SANDBOX, url: "http://sandbox.example/mcp" } },
  });
  await expect(loadReviewConfig(root)).rejects.toThrow(/https/);

  await writeRootConfig({
    mcpServers: { sandbox: { ...SANDBOX, url: "http://127.0.0.1:8787/mcp" } },
  });
  expect((await loadReviewConfig(root)).mcpServers?.sandbox?.url).toBe("http://127.0.0.1:8787/mcp");

  // A malformed url is a config error with its path, not a bare URL TypeError.
  await writeRootConfig({ mcpServers: { sandbox: { ...SANDBOX, url: "not a url" } } });
  await expect(loadReviewConfig(root)).rejects.toThrow(/mcpServers/);
});

test("refuses the research server's name, which a server would replace", async () => {
  await writeRootConfig({ mcpServers: { platform_docs: SANDBOX } });
  await expect(loadReviewConfig(root)).rejects.toThrow(/platform_docs/);
});

test("refuses server names whose OpenCode tool names could collide", async () => {
  await writeRootConfig({ mcpServers: { box: SANDBOX, box_two: SANDBOX } });
  await expect(loadReviewConfig(root)).rejects.toThrow(/another server's name/);
});

test("refuses a token info url on another origin than the server", async () => {
  await writeRootConfig({
    mcpServers: {
      sandbox: { ...SANDBOX, tokenInfoUrl: "https://collector.example/tokens/info" },
    },
  });
  await expect(loadReviewConfig(root)).rejects.toThrow(/same origin/);
  await writeRootConfig({
    mcpServers: { sandbox: { ...SANDBOX, tokenInfoUrl: "https://sandbox.example/tokens/info" } },
  });
  expect((await loadReviewConfig(root)).mcpServers?.sandbox?.tokenInfoUrl).toBe(
    "https://sandbox.example/tokens/info",
  );
});

test("refuses a token env that holds another secret or the model credential", async () => {
  for (const tokenEnv of [
    "GH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "META_API_KEY",
    "MODEL_TOKEN",
    "CODEX_OAUTH_ACCESS_TOKEN",
    "CODEX_OAUTH_REFRESH_TOKEN",
  ]) {
    await writeRootConfig({
      auth: { mode: "api-key", provider: "anthropic", tokenEnv: "MODEL_TOKEN" },
      mcpServers: { sandbox: { ...SANDBOX, tokenEnv } },
    });
    await expect(loadReviewConfig(root)).rejects.toThrow(new RegExp(tokenEnv));
  }
});

test("a scope config cannot add an MCP server", () => {
  const result = ScopeReviewConfigSchema.safeParse({ mcpServers: { sandbox: SANDBOX } });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).toContain("root config");
});

test("an OpenCode pass with no tool budget cannot call a configured MCP tool", async () => {
  const off = opencodeMcpToolsOff({ sandbox: SANDBOX });
  expect(off).toEqual({ sandbox_create_sandbox: false, sandbox_sandbox_exec: false });

  const sent: Array<Record<string, unknown>> = [];
  const handle = (mcpToolsOff?: Record<string, boolean>): OpencodeHandle => ({
    url: "",
    close: () => {},
    rateLimit: new RateLimitWatch(),
    ...(mcpToolsOff ? { mcpToolsOff } : {}),
    client: {
      session: {
        create: async () => ({ data: { id: "s" } }),
        promptAsync: async ({ body }: { body: Record<string, unknown> }) => {
          sent.push(body);
          return { data: {} };
        },
        messages: async () => ({
          data: [
            {
              info: { role: "assistant", time: { completed: 1 } },
              parts: [{ type: "text", text: "{}" }],
            },
          ],
        }),
      },
    },
  });
  const args = { agent: "deep", system: "s", text: "t", title: "t" };

  await promptAgent(handle(off), { ...args, maxToolCalls: 0 });
  expect(sent[0]!.tools).toEqual(off);
  // A pass with a budget keeps its grant, and a run without servers sends no override.
  await promptAgent(handle(off), args);
  await promptAgent(handle(), { ...args, maxToolCalls: 0 });
  expect(sent.slice(1).map((body) => "tools" in body)).toEqual([false, false]);
});

test("refuses requireNoNetwork without a token info url to check it against", async () => {
  await writeRootConfig({ mcpServers: { sandbox: { ...SANDBOX, requireNoNetwork: true } } });
  await expect(loadReviewConfig(root)).rejects.toThrow(/tokenInfoUrl/);
});

test("should refuse requireNoSudo without a token info url to check it against", async () => {
  await writeRootConfig({ mcpServers: { sandbox: { ...SANDBOX, requireNoSudo: true } } });
  await expect(loadReviewConfig(root)).rejects.toThrow(/requireNoSudo needs tokenInfoUrl/);
});

test("should load requireNoSudo with a token info url, and leave it off by default", async () => {
  const tokenInfoUrl = "https://sandbox.example/tokens/info";
  await writeRootConfig({
    mcpServers: { sandbox: { ...SANDBOX, tokenInfoUrl, requireNoSudo: true } },
  });
  expect((await loadReviewConfig(root)).mcpServers?.sandbox?.requireNoSudo).toBe(true);
  const { requireNoSudo: _omitted, ...withoutKey } = SANDBOX;
  await writeRootConfig({ mcpServers: { sandbox: withoutKey } });
  expect((await loadReviewConfig(root)).mcpServers?.sandbox?.requireNoSudo).toBe(false);
});

test("should let auth.tokenEnv still name a Codex subscription token", async () => {
  await writeRootConfig({
    auth: { mode: "oauth", provider: "openai", tokenEnv: "CODEX_OAUTH_ACCESS_TOKEN" },
    mcpServers: { sandbox: SANDBOX },
  });
  expect((await loadReviewConfig(root)).mcpServers?.sandbox).toEqual(SANDBOX);
});

test("should report a bad url next to a token info url as a config issue, not a crash", () => {
  const tokenInfoUrl = "https://sandbox.example/tokens/info";
  const badUrl = McpServerConfigSchema.safeParse({ ...SANDBOX, url: "not a url", tokenInfoUrl });
  expect(badUrl.success).toBe(false);
  expect(JSON.stringify(badUrl.error?.issues)).toContain("url");
  const badInfo = McpServerConfigSchema.safeParse({ ...SANDBOX, tokenInfoUrl: "not a url" });
  expect(badInfo.success).toBe(false);
});

test("should refuse a server whose tool name would form a research tool name", async () => {
  await writeRootConfig({
    mcpServers: { platform: { ...SANDBOX, tools: ["docs_search_platform_docs"] } },
  });
  await expect(loadReviewConfig(root)).rejects.toThrow(/research tool name/);
  await writeRootConfig({ mcpServers: { platform: SANDBOX } });
  expect((await loadReviewConfig(root)).mcpServers?.platform).toEqual(SANDBOX);
});

test("should refuse to grant a server to the adjudicator, coordinator or stack verifier", async () => {
  for (const agent of ["adjudicator", "coordinator", "stack-verifier"]) {
    await writeRootConfig({ mcpServers: { sandbox: { ...SANDBOX, agents: ["deep", agent] } } });
    await expect(loadReviewConfig(root)).rejects.toThrow(/never get an MCP server/);
    expect(mcpServerGrants({ sandbox: { ...SANDBOX, agents: [agent] } }, agent)).toEqual([]);
  }
});

test("should give a pass the token env of its granted servers only", () => {
  const other: McpServerConfig = { ...SANDBOX, tokenEnv: "OTHER_TOKEN", agents: ["security"] };
  const env = { REVIEW_SANDBOX_TOKEN: "sandbox", OTHER_TOKEN: "other" };
  const servers = { sandbox: SANDBOX, other };
  expect(mcpGrantEnvironment(mcpServerGrants(servers, "deep"), env)).toEqual({
    REVIEW_SANDBOX_TOKEN: "sandbox",
  });
  expect(mcpGrantEnvironment(mcpServerGrants(servers, "coordinator"), env)).toEqual({});
  expect(mcpGrantEnvironment(mcpServerGrants(servers, "deep"), {})).toEqual({});
});

test("should give OpenCode a timeout past the proxy's call deadline and discovery", () => {
  expect(opencodeMcpTimeoutMs({ timeoutMs: 120_000 })).toBe(135_000);
  expect(opencodeMcpTimeoutMs({ timeoutMs: 600_000 })).toBe(615_000);
  // A short call deadline still leaves room for the proxy to reach the server.
  expect(opencodeMcpTimeoutMs({ timeoutMs: 1_000 })).toBe(60_000);
  expect(opencodeMcpTimeoutMs(undefined)).toBe(60_000);
});

test("should start the proxy through its env wrapper", async () => {
  const runtime = (await createMcpProxyRuntime({ sandbox: SANDBOX }))!;
  try {
    const [command, entry] = runtime.commands.get("sandbox")!;
    expect(command).toBe(process.execPath);
    expect(path.basename(entry!)).toMatch(/^wrapper\.(js|ts)$/);
    expect(existsSync(entry!)).toBe(true);
  } finally {
    await runtime.cleanup();
  }
});

test("should share one audit between routed runs and tag each run's events", async () => {
  const shared = await createSharedMcpAudit();
  const first = (await createMcpProxyRuntime(
    { sandbox: SANDBOX },
    { auditPath: shared.auditPath, run: "run-a" },
  ))!;
  const second = (await createMcpProxyRuntime(
    { sandbox: SANDBOX },
    { auditPath: shared.auditPath, run: "run-b" },
  ))!;
  try {
    expect(first.auditPath).toBe(shared.auditPath);
    expect(second.auditPath).toBe(shared.auditPath);
    const settingsOf = async (runtime: typeof first) =>
      JSON.parse(await readFile(runtime.commands.get("sandbox")!.at(-1)!, "utf8")) as {
        run?: string;
        auditPath: string;
      };
    expect(await settingsOf(first)).toMatchObject({ run: "run-a", auditPath: shared.auditPath });
    expect(await settingsOf(second)).toMatchObject({ run: "run-b", auditPath: shared.auditPath });
    // A run's cleanup leaves the shared audit for the next scope.
    await writeFile(shared.auditPath, "");
    await first.cleanup();
    expect(existsSync(shared.auditPath)).toBe(true);
  } finally {
    await second.cleanup();
    await shared.cleanup();
  }
  expect(existsSync(path.dirname(shared.auditPath))).toBe(false);
});
