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

  test(
    "should not start an MCP server that the checkout defines",
    async () => {
      const bin = await resolveOpencodeCli();
      expect(bin).toBeTruthy();
      const home = await mkdtemp(path.join(tmpdir(), "ecr-attach-config-"));
      const cwd = path.join(home, "repo");
      await mkdir(cwd, { recursive: true });
      const marker = path.join(home, "mcp-ran");
      const script = path.join(cwd, "mcp.sh");
      await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
      await writeFile(
        path.join(cwd, "opencode.json"),
        JSON.stringify({ mcp: { fromCheckout: { type: "local", command: [script] } } }),
      );
      const base: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      };
      delete base.OPENCODE_CONFIG;
      delete base.OPENCODE_CONFIG_DIR;
      delete base.OPENCODE_CONFIG_CONTENT;
      delete base.OPENCODE_DISABLE_PROJECT_CONFIG;

      // The MCP servers that a server started in the checkout knows about.
      const mcpServers = async (env: NodeJS.ProcessEnv): Promise<string[]> => {
        const server = spawnPiped(
          bin!,
          ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"],
          { cwd, env },
        );
        try {
          const url = await waitForServer(server);
          const response = await fetch(`${url}/mcp?directory=${encodeURIComponent(cwd)}`);
          return Object.keys((await response.json()) as Record<string, unknown>);
        } finally {
          server.kill("SIGKILL");
        }
      };

      try {
        expect(await mcpServers(attachEnv(base))).toEqual([]);
        expect(existsSync(marker)).toBe(false);
        // Without the attach environment the same checkout does define one.
        expect(await mcpServers(base)).toEqual(["fromCheckout"]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
