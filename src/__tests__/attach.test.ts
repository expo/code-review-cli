import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { attachEnv, pickPass, waitForServer } from "../commands/attach.js";
import { spawnPiped } from "../core/exec.js";
import { resolveOpencodeCli } from "../core/opencode.js";
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
});
