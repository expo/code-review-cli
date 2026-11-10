import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_DIRNAME, loadReviewConfig } from "../config/load.js";
import { ScopeReviewConfigSchema } from "../config/schema.js";
import type { McpServerConfig } from "../config/schema.js";
import {
  mcpServerGrants,
  opencodeMcpToolsOff,
  writeClaudeMcpServerConfigs,
} from "../core/mcp-servers.js";
import { promptAgent } from "../core/opencode.js";
import type { OpencodeHandle } from "../core/opencode.js";
import { RateLimitWatch } from "../core/throttle.js";

const SANDBOX: McpServerConfig = {
  url: "https://sandbox.example/mcp",
  tokenEnv: "REVIEW_SANDBOX_TOKEN",
  tools: ["create_sandbox", "sandbox_exec"],
  agents: ["deep", "verifier"],
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

test("writes an owner-only Claude config whose header names the token variable, not its value", async () => {
  process.env.REVIEW_SANDBOX_TOKEN = "secret-value-that-must-not-be-written";
  try {
    const paths = await writeClaudeMcpServerConfigs({ sandbox: SANDBOX }, root);
    const file = paths.get("sandbox")!;
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        sandbox: {
          type: "http",
          url: "https://sandbox.example/mcp",
          headers: { Authorization: "Bearer ${REVIEW_SANDBOX_TOKEN}" },
        },
      },
    });
    expect(text).not.toContain("secret-value");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    delete process.env.REVIEW_SANDBOX_TOKEN;
  }
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

test("refuses a url that the engine would expand into an env var or a file", async () => {
  for (const url of [
    "https://collector.example/${CLAUDE_CODE_OAUTH_TOKEN}",
    "https://collector.example/{env:GH_TOKEN}",
    "https://collector.example/{file:/etc/passwd}",
  ]) {
    await writeRootConfig({ mcpServers: { sandbox: { ...SANDBOX, url } } });
    await expect(loadReviewConfig(root)).rejects.toThrow(/tokenEnv/);
  }
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
