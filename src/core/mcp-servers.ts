// @ref LLP 0003#configured-mcp-servers [implements] — root-only remote MCP servers, granted per pass, token by env var name
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "../config/schema.js";
import type { McpServerUsage } from "../mcp-proxy/audit.js";
import type { McpProxySettings } from "../mcp-proxy/server.js";
import { FORBIDDEN_TOKEN_ENVS, MODEL_CREDENTIAL_ENVS } from "./auth.js";

/** One server a pass may call, with the tool names it may call there. */
export interface McpServerGrant {
  name: string;
  server: McpServerConfig;
  tools: string[];
}

/** The servers granted to one pass, in config order. */
export function mcpServerGrants(
  servers: Record<string, McpServerConfig> | undefined,
  agentId: string,
): McpServerGrant[] {
  return Object.entries(servers ?? {})
    .filter(([, server]) => server.agents.includes(agentId))
    .map(([name, server]) => ({ name, server, tools: [...server.tools] }));
}

/**
 * Refuse a server whose bearer would be another secret. The config comes from the
 * trusted base, but a token env must still only ever hold a token minted for that
 * server, like `auth.tokenEnv` for the model provider.
 */
export function assertMcpServerTokenEnvs(
  servers: Record<string, McpServerConfig> | undefined,
  authTokenEnvs: readonly string[],
): void {
  for (const [name, server] of Object.entries(servers ?? {})) {
    const env = server.tokenEnv;
    if (
      env &&
      (FORBIDDEN_TOKEN_ENVS.has(env) ||
        MODEL_CREDENTIAL_ENVS.has(env) ||
        authTokenEnvs.includes(env))
    ) {
      throw new Error(
        `mcpServers.${name}.tokenEnv "${env}" holds another credential; give the server its own token env.`,
      );
    }
  }
}

/** The configured servers whose token env is set, so a missing token skips its server. */
export function availableMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).filter(([, server]) => !server.tokenEnv || env[server.tokenEnv]),
  );
}

/** Drop the servers a fork pull request must not get. Local runs never call this. */
export function mcpServersForPullRequest(
  servers: Record<string, McpServerConfig> | undefined,
  pullRequest: { fork: boolean; labels: readonly string[] },
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).filter(
      ([, server]) =>
        !pullRequest.fork ||
        (server.forkLabel !== undefined && pullRequest.labels.includes(server.forkLabel)),
    ),
  );
}

/** The engines start this proxy. Only the proxy talks to the remote server. */
export function bundledMcpProxy(): { command: string; args: string[] } {
  const builtEntry = fileURLToPath(new URL("../mcp-proxy/cli.js", import.meta.url));
  const sourceEntry = fileURLToPath(new URL("../mcp-proxy/cli.ts", import.meta.url));
  return {
    command: process.execPath,
    args: [existsSync(builtEntry) ? builtEntry : sourceEntry],
  };
}

export interface McpProxyRuntime {
  /** The servers this run serves: configured, token set. */
  servers: Record<string, McpServerConfig>;
  auditPath: string;
  /** One Claude `--mcp-config` file per server. */
  claudeConfigPaths: ReadonlyMap<string, string>;
  /** The proxy command line per server, for OpenCode. */
  commands: ReadonlyMap<string, string[]>;
  cleanup(): Promise<void>;
}

/**
 * One owner-only directory per run: a settings file and a Claude config per server,
 * and the audit all proxies share.
 * No file holds the token. The proxy reads it from the env var the settings name.
 */
export async function createMcpProxyRuntime(
  servers: Record<string, McpServerConfig>,
): Promise<McpProxyRuntime | undefined> {
  if (Object.keys(servers).length === 0) {
    return undefined;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "ecr-mcp-"));
  const auditPath = path.join(directory, "audit.jsonl");
  const proxy = bundledMcpProxy();
  const claudeConfigPaths = new Map<string, string>();
  const commands = new Map<string, string[]>();
  for (const [name, server] of Object.entries(servers)) {
    const settingsPath = path.join(directory, `${name}.settings.json`);
    const settings: McpProxySettings = {
      name,
      url: server.url,
      ...(server.tokenEnv ? { tokenEnv: server.tokenEnv } : {}),
      ...(server.tokenInfoUrl ? { tokenInfoUrl: server.tokenInfoUrl } : {}),
      tools: server.tools,
      extraTokenTools: server.extraTokenTools,
      maxCalls: server.maxCalls,
      timeoutMs: server.timeoutMs,
      maxOutputBytes: server.maxOutputBytes,
      auditPath,
    };
    await writeFile(settingsPath, `${JSON.stringify(settings)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const args = [...proxy.args, settingsPath];
    commands.set(name, [proxy.command, ...args]);
    const configPath = path.join(directory, `${name}.json`);
    await writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: proxy.command, args } } })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    claudeConfigPaths.set(name, configPath);
  }
  return {
    servers,
    auditPath,
    claudeConfigPaths,
    commands,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** OpenCode's `mcp` entries: each server is the local proxy. */
export function opencodeMcpServers(runtime: McpProxyRuntime | undefined): Record<string, unknown> {
  return Object.fromEntries(
    [...(runtime?.commands ?? [])].map(([name, command]) => [
      name,
      // `timeout` bounds tool discovery, which waits for the proxy to reach the server.
      { type: "local", command, enabled: true, timeout: 30_000 },
    ]),
  );
}

/**
 * Every configured tool switched off, for a per-request override. OpenCode matches
 * request overrides by exact name and keeps the agent's grant for a name left out, so
 * the `<server>_*` wildcard in the config cannot do this.
 */
export function opencodeMcpToolsOff(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).flatMap(([name, server]) =>
      server.tools.map((tool) => [`${name}_${tool}`, false]),
    ),
  );
}

/** Progress lines for the run's server usage. A refused server names its fix. */
export function formatMcpServerUsage(usage: readonly McpServerUsage[]): string[] {
  return usage.map((entry) => {
    if (entry.refused === "token-too-broad") {
      return `  MCP server "${entry.server}" refused: it offers tools the config does not name, so its token is not scoped to this review. Mint a scoped token, or list the tools in extraTokenTools.`;
    }
    if (entry.refused === "token-not-scoped") {
      return `  MCP server "${entry.server}" refused: its token is not a scoped token that expires. Mint a scoped token for each review run.`;
    }
    if (entry.refused === "unavailable") {
      return `  MCP server "${entry.server}" was not reachable; the review ran without it.`;
    }
    const rejected = entry.rejected > 0 ? `, ${entry.rejected} refused` : "";
    return `  MCP server "${entry.server}": ${entry.calls} call(s), ${entry.errors} error(s)${rejected}.`;
  });
}

/** OpenCode tool switches for one pass: only its granted tools are turned on. */
export function opencodeGrantedTools(
  servers: Record<string, McpServerConfig> | undefined,
  agentId: string,
): Record<string, boolean> {
  return Object.fromEntries(
    mcpServerGrants(servers, agentId).flatMap((grant) =>
      grant.tools.map((tool) => [`${grant.name}_${tool}`, true]),
    ),
  );
}
