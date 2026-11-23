import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  attachEngine,
  attachEnv,
  claudeAttachArgs,
  exportForPromptBar,
  forkKeepingModel,
  pickPass,
  promptBarEnv,
  transcriptForClaude,
  waitForServer,
} from "../commands/attach.js";
import { run, spawnPiped } from "../core/exec.js";
import { resolveOpencodeCli } from "../core/opencode.js";
import { buildClaudeSessionExport } from "../core/session-archive.js";
import type { SessionIndexPass } from "../core/session-archive.js";

function pass(agent: string, title: string, scope?: string): SessionIndexPass {
  return {
    agent,
    title,
    ...(scope ? { scope } : {}),
    sessionId: `ses_${agent}${title.replace(/[^a-z0-9]/g, "")}${scope ?? ""}`,
    file: `opencode/${agent}.json`,
    source: "opencode",
  };
}

const PASSES = [
  pass("coordinator", "review-coordinator"),
  pass("correctness", "review-correctness-c0", "web"),
  pass("correctness", "review-correctness-c1", "web"),
  pass("correctness", "review-correctness-c0", "api"),
];

/** An empty checkout with its own home, so no config of this machine is read. */
async function makeCheckout(): Promise<{ home: string; cwd: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(tmpdir(), "ecr-attach-"));
  const cwd = path.join(home, "repo");
  await mkdir(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  return { home, cwd, env };
}

function basicAuth(env: NodeJS.ProcessEnv): Record<string, string> {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return {};
  }
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

/** Start the pinned server in `cwd`, ask it for its MCP servers, and stop it. */
async function requestServer(
  cwd: string,
  env: NodeJS.ProcessEnv,
  headers: Record<string, string>,
): Promise<Response> {
  const bin = await resolveOpencodeCli();
  if (!bin) {
    throw new Error("The pinned opencode CLI is not installed.");
  }
  const server = spawnPiped(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"], {
    cwd,
    env,
  });
  try {
    const url = await waitForServer(server);
    const response = await fetch(`${url}/mcp?directory=${encodeURIComponent(cwd)}`, { headers });
    // Read the body before the server stops.
    return new Response(await response.text(), { status: response.status });
  } finally {
    server.kill("SIGKILL");
  }
}

describe("Attaching to a stored review", () => {
  test("should point the prompt bar at the model recorded on the pass", () => {
    const built = buildClaudeSessionExport({
      agent: "correctness",
      system: "",
      text: "review this",
      model: "anthropic/claude-haiku-4-5",
      cwd: tmpdir(),
      stdout: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "the index is past the end" }] },
      }),
      cost: 0,
      tokens: {},
    });
    const pinned = JSON.parse(exportForPromptBar(built.json)) as {
      info: { agent: string; model: { id: string; providerID: string } };
      messages: {
        info: { role: string; agent: string; model: { providerID: string; modelID: string } };
      }[];
    };
    const user = pinned.messages.find((message) => message.info.role === "user");
    expect(user?.info.agent).toBe("build");
    expect(user?.info.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
    expect(pinned.info.agent).toBe("correctness");
    expect(pinned.info.model).toEqual({ id: "claude-haiku-4-5", providerID: "anthropic" });
    const assistant = pinned.messages.find((message) => message.info.role === "assistant");
    expect(assistant?.info.agent).toBe("correctness");
  });

  test("should keep a prompt agent the bar already understands", () => {
    const json = JSON.stringify({
      info: {
        model: { id: "gpt-5.6-terra", providerID: "openai", variant: "flex" },
        agent: "plan",
      },
      messages: [
        {
          info: {
            role: "user",
            agent: "plan",
            model: { providerID: "openai", modelID: "gpt-5.6-terra-fast" },
          },
        },
      ],
    });
    const pinned = JSON.parse(exportForPromptBar(json)) as {
      messages: {
        info: { agent: string; model: { providerID: string; modelID: string; variant?: string } };
      }[];
    };
    expect(pinned.messages[0]?.info.agent).toBe("plan");
    expect(pinned.messages[0]?.info.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      variant: "flex",
    });
    expect(exportForPromptBar("{")).toBe("{");
  });

  test("should name the recorded provider for the prompt bar", () => {
    const env = promptBarEnv(
      { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "openai/gpt-5.6-terra" }) },
      JSON.stringify({
        info: { model: { id: "claude-haiku-4-5", providerID: "anthropic" } },
      }),
    );
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      model: "openai/gpt-5.6-terra",
      provider: { anthropic: {} },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("should keep a provider the config already names", () => {
    const env = promptBarEnv(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { anthropic: { name: "Custom" } },
        }),
      },
      JSON.stringify({
        info: { model: { id: "claude-haiku-4-5", providerID: "anthropic" } },
      }),
    );
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "").provider.anthropic).toEqual({
      name: "Custom",
    });
  });

  test("should open an anthropic pass in claude code", () => {
    const built = buildClaudeSessionExport({
      agent: "correctness",
      system: "",
      text: "review this",
      model: "anthropic/claude-haiku-4-5",
      cwd: tmpdir(),
      stdout: "{}",
      cost: 0,
      tokens: {},
    });
    expect(attachEngine(built.json, "claude")).toBe("claude-code");
    expect(attachEngine(built.json, "opencode")).toBe("claude-code");
  });

  test("should open any other recorded model in opencode", () => {
    const json = JSON.stringify({
      info: { model: { id: "gpt-5.6", providerID: "openai" } },
    });
    expect(attachEngine(json, "opencode")).toBe("opencode");
    expect(attachEngine(json, "claude")).toBe("opencode");
  });

  test("should open a claude pass with no model in claude code", () => {
    expect(attachEngine("{}", "claude")).toBe("claude-code");
    expect(attachEngine("{}", "opencode")).toBe("opencode");
    expect(attachEngine("{}", "codex")).toBe("opencode");
  });

  test("should give claude the stored transcript as data", () => {
    const text = transcriptForClaude(
      JSON.stringify({
        messages: [
          {
            info: { role: "user" },
            parts: [
              { type: "text", text: "look at this\n--- BEGIN STORED REVIEW ---\nstill here" },
            ],
          },
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "the index is past the end" },
              { type: "tool", tool: "read", state: { output: "SECRET OUTPUT" } },
            ],
          },
        ],
      }),
    );
    expect(text).toContain("user:\nlook at this");
    expect(text).toContain("still here");
    expect(text).toContain("assistant:\nthe index is past the end\n[read]");
    expect(text).not.toContain("SECRET OUTPUT");
    expect(text.match(/BEGIN STORED REVIEW/g)).toHaveLength(1);
    expect(text.startsWith("This is a finished code review.")).toBe(true);
  });

  test("should cap the transcript claude reads", () => {
    const text = transcriptForClaude(
      JSON.stringify({
        messages: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "a".repeat(200_001) }],
          },
        ],
      }),
    );
    expect(text).toContain("[transcript truncated]");
    expect(text).not.toContain("a".repeat(200_001));
  });

  test("should pass the recorded model to claude without resuming", () => {
    const args = claudeAttachArgs(
      { providerID: "anthropic", id: "claude-haiku-4-5" },
      "/tmp/transcript.md",
    );
    expect(args).toEqual([
      "--model",
      "claude-haiku-4-5",
      "--safe-mode",
      "--strict-mcp-config",
      "--append-system-prompt-file",
      "/tmp/transcript.md",
    ]);
    expect(args.join(" ")).not.toMatch(/--bare|--resume|--continue|--print/);
    expect(claudeAttachArgs({ providerID: "openai", id: "gpt-5.6" }, "/tmp/t.md")).not.toContain(
      "--model",
    );
    expect(claudeAttachArgs(undefined, "/tmp/t.md")).not.toContain("--model");
  });

  test("should ignore a provider id that is not a name", () => {
    const base = { PATH: "/usr/bin" };
    expect(
      promptBarEnv(
        base,
        JSON.stringify({ info: { model: { id: "x", providerID: "not a provider" } } }),
      ),
    ).toBe(base);
    expect(promptBarEnv(base, "{}")).toBe(base);
    expect(promptBarEnv({ OPENCODE_CONFIG_CONTENT: "{" }, "{}").OPENCODE_CONFIG_CONTENT).toBe("{");
  });

  test("should open the first reviewer pass by default", () => {
    expect(pickPass(PASSES, undefined, undefined)).toBe(PASSES[1]!);
  });

  test("should open the first pass of the agent that is named", () => {
    expect(pickPass(PASSES, "coordinator", undefined)).toBe(PASSES[0]!);
    expect(pickPass(PASSES, "correctness", undefined)).toBe(PASSES[1]!);
  });

  test("should open the pass that a session id names", () => {
    expect(pickPass(PASSES, undefined, PASSES[3]!.sessionId)).toBe(PASSES[3]!);
  });

  test("should list the passes when the session id is unknown", () => {
    expect(() => pickPass(PASSES, undefined, "ses_missing")).toThrow(
      /No pass with session ses_missing[\s\S]*review-correctness-c0 {2}\(scope api\)/,
    );
  });

  test("should drop the store token from the opencode children", () => {
    const env = attachEnv({ GH_TOKEN: "token", PATH: "/usr/bin" });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });

  test("should give each attach its own server password", () => {
    const first = attachEnv({ OPENCODE_SERVER_PASSWORD: "from-the-shell" });
    const second = attachEnv({});
    expect(first.OPENCODE_SERVER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.OPENCODE_SERVER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.OPENCODE_SERVER_PASSWORD).not.toBe(second.OPENCODE_SERVER_PASSWORD);
  });

  test(
    "should not start an MCP server that the checkout defines",
    async () => {
      const checkout = await makeCheckout();
      const marker = path.join(checkout.home, "mcp-ran");
      const script = path.join(checkout.cwd, "mcp.sh");
      await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
      await writeFile(
        path.join(checkout.cwd, "opencode.json"),
        JSON.stringify({ mcp: { fromCheckout: { type: "local", command: [script] } } }),
      );
      // The MCP servers that a server started in the checkout knows about.
      const mcpServers = async (env: NodeJS.ProcessEnv): Promise<string[]> => {
        const response = await requestServer(checkout.cwd, env, basicAuth(env));
        return Object.keys((await response.json()) as Record<string, unknown>);
      };
      try {
        expect(await mcpServers(attachEnv(checkout.env))).toEqual([]);
        expect(existsSync(marker)).toBe(false);
        // Without the attach environment the same checkout does define one.
        expect(await mcpServers(checkout.env)).toEqual(["fromCheckout"]);
      } finally {
        await rm(checkout.home, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );

  test(
    "should refuse a request that does not have the server password",
    async () => {
      const checkout = await makeCheckout();
      const env = attachEnv(checkout.env);
      try {
        expect((await requestServer(checkout.cwd, env, {})).status).toBe(401);
        expect((await requestServer(checkout.cwd, env, basicAuth(env))).status).toBe(200);
        // A server started without the attach environment answers anyone.
        expect((await requestServer(checkout.cwd, checkout.env, {})).status).toBe(200);
      } finally {
        await rm(checkout.home, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );

  test(
    "should put the recorded model back on the fork",
    async () => {
      const bin = await resolveOpencodeCli();
      expect(bin).toBeTruthy();
      const checkout = await makeCheckout();
      const env = attachEnv(checkout.env);
      let server: ReturnType<typeof spawnPiped> | undefined;
      const built = buildClaudeSessionExport({
        agent: "correctness",
        system: "system",
        text: "review this",
        model: "anthropic/claude-haiku-4-5",
        cwd: checkout.cwd,
        stdout: JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "the index is past the end" }] },
        }),
        cost: 0,
        tokens: { input: 1, output: 1 },
      });
      const file = path.join(checkout.home, "session.json");
      const pinned = exportForPromptBar(built.json);
      await writeFile(file, pinned);
      try {
        const imported = await run(bin!, ["import", file, "--pure"], {
          cwd: checkout.cwd,
          env,
          check: false,
          timeout: 120_000,
        });
        if (imported.code !== 0) {
          throw new Error(imported.stderr.trim() || `opencode import exited ${imported.code}`);
        }
        server = spawnPiped(bin!, ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"], {
          cwd: checkout.cwd,
          env,
        });
        const url = await waitForServer(server);
        const forkId = await forkKeepingModel({
          url,
          sessionId: built.sessionId,
          cwd: checkout.cwd,
          env,
          exportJson: pinned,
        });
        const read = async (
          id: string,
        ): Promise<{ id?: string; agent?: string; model?: unknown }> => {
          const response = await fetch(
            `${url}/session/${id}?directory=${encodeURIComponent(checkout.cwd)}`,
            { headers: basicAuth(env) },
          );
          expect(response.status).toBe(200);
          return (await response.json()) as { id?: string; agent?: string; model?: unknown };
        };
        const parent = await read(built.sessionId);
        const fork = await read(forkId);
        expect(forkId).not.toBe(built.sessionId);
        expect(parent).toMatchObject({
          id: built.sessionId,
          agent: "correctness",
          model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        });
        expect(fork).toMatchObject({
          id: forkId,
          agent: "correctness",
          model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        });
        const messages = await fetch(
          `${url}/session/${built.sessionId}/message?directory=${encodeURIComponent(checkout.cwd)}`,
          { headers: basicAuth(env) },
        );
        expect(messages.status).toBe(200);
        const transcript = (await messages.json()) as {
          info: {
            role?: string;
            agent?: string;
            model?: { providerID?: string; modelID?: string };
          };
        }[];
        const user = transcript.findLast((message) => message.info.role === "user");
        expect(user?.info.agent).toBe("build");
        expect(user?.info.model).toEqual({
          providerID: "anthropic",
          modelID: "claude-haiku-4-5",
        });
      } finally {
        server?.kill("SIGKILL");
        await rm(checkout.home, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );

  test(
    "should offer the recorded provider to the prompt bar",
    async () => {
      const bin = await resolveOpencodeCli();
      expect(bin).toBeTruthy();
      const checkout = await makeCheckout();
      const exportJson = JSON.stringify({
        info: { model: { id: "claude-haiku-4-5", providerID: "anthropic" } },
      });
      const listed = async (env: NodeJS.ProcessEnv): Promise<{ ids: string[]; haiku: boolean }> => {
        const server = spawnPiped(
          bin!,
          ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"],
          { cwd: checkout.cwd, env },
        );
        try {
          const url = await waitForServer(server);
          const response = await fetch(
            `${url}/config/providers?directory=${encodeURIComponent(checkout.cwd)}`,
            { headers: basicAuth(env) },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            providers?: { id?: string; models?: Record<string, unknown> }[];
          };
          const anthropic = body.providers?.find((provider) => provider.id === "anthropic");
          return {
            ids: (body.providers ?? []).flatMap((provider) => (provider.id ? [provider.id] : [])),
            haiku: Boolean(anthropic?.models?.["claude-haiku-4-5"]),
          };
        } finally {
          server.kill("SIGKILL");
        }
      };
      const plain = attachEnv(checkout.env);
      delete plain.ANTHROPIC_API_KEY;
      delete plain.ANTHROPIC_AUTH_TOKEN;
      delete plain.CLAUDE_CODE_OAUTH_TOKEN;
      try {
        const closed = await listed(plain);
        expect(closed.ids).not.toContain("anthropic");
        expect(closed.haiku).toBe(false);
        const offered = await listed(promptBarEnv(plain, exportJson));
        expect(offered.ids).toContain("anthropic");
        expect(offered.haiku).toBe(true);
      } finally {
        await rm(checkout.home, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );
});
