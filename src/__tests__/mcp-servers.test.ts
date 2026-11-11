import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_DIRNAME, loadReviewConfig } from "../config/load.js";
import { ScopeReviewConfigSchema } from "../config/schema.js";
import type { McpServerConfig } from "../config/schema.js";
import {
  createMcpProxyRuntime,
  mcpServerGrants,
  mcpServersForPullRequest,
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
