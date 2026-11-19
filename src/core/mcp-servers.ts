// @ref LLP 0003#configured-mcp-servers [implements] — root-only remote MCP servers, granted per pass, token by env var name
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_UNGRANTABLE_AGENTS } from "../config/schema.js";
import type { McpServerConfig } from "../config/schema.js";
import type { McpServerUsage } from "../mcp-proxy/audit.js";
import { MCP_PROXY_DISCOVERY_MS } from "../mcp-proxy/server.js";
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
  // The schema already refuses these ids. This keeps a hand-built config from granting them.
  if ((MCP_UNGRANTABLE_AGENTS as readonly string[]).includes(agentId)) {
    return [];
  }
  return Object.entries(servers ?? {})
    .filter(([, server]) => server.agents.includes(agentId))
    .map(([name, server]) => ({ name, server, tools: [...server.tools] }));
}

/** The token env of each granted server, for the env of that one pass only. */
export function mcpGrantEnvironment(
  grants: readonly McpServerGrant[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    grants.flatMap((grant) => {
      const name = grant.server.tokenEnv;
      const value = name ? env[name] : undefined;
      return name && value ? [[name, value]] : [];
    }),
  );
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

/**
 * The engines start the proxy's wrapper. Only the proxy talks to the remote server.
 * The wrapper gives the proxy a built environment, because both engines merge their
 * own environment into an MCP child.
 */
export function bundledMcpProxy(): { command: string; args: string[] } {
  const builtEntry = fileURLToPath(new URL("../mcp-proxy/wrapper.js", import.meta.url));
  const sourceEntry = fileURLToPath(new URL("../mcp-proxy/wrapper.ts", import.meta.url));
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

/** An audit, and so a call budget, that several runs share. */
export interface SharedMcpAudit {
  auditPath: string;
  cleanup(): Promise<void>;
}

/**
 * One budget for every routed scope of an `ecr ci` run.
 * Without it each scope gets its own audit and `maxCalls` multiplies by the scope count.
 */
export async function createSharedMcpAudit(): Promise<SharedMcpAudit> {
  const directory = await mkdtemp(path.join(tmpdir(), "ecr-mcp-budget-"));
  return {
    auditPath: path.join(directory, "audit.jsonl"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export interface McpProxyRuntimeOptions {
  /** A shared audit to use instead of a new one. The runtime never removes it. */
  auditPath?: string;
  /** Tags this run's events in a shared audit, so its usage report shows its own calls. */
  run?: string;
}

/**
 * One owner-only directory per run: a settings file and a Claude config per server,
 * and the audit all proxies share.
 * No file holds the token. The proxy reads it from the env var the settings name.
 */
export async function createMcpProxyRuntime(
  servers: Record<string, McpServerConfig>,
  options: McpProxyRuntimeOptions = {},
): Promise<McpProxyRuntime | undefined> {
  if (Object.keys(servers).length === 0) {
    return undefined;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "ecr-mcp-"));
  const auditPath = options.auditPath ?? path.join(directory, "audit.jsonl");
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
      ...(server.requireNoNetwork ? { requireNoNetwork: true } : {}),
      ...(server.requireNoSudo ? { requireNoSudo: true } : {}),
      tools: server.tools,
      extraTokenTools: server.extraTokenTools,
      maxCalls: server.maxCalls,
      timeoutMs: server.timeoutMs,
      maxOutputBytes: server.maxOutputBytes,
      auditPath,
      ...(options.run !== undefined ? { run: options.run } : {}),
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

// Room for the proxy to end a call at its own deadline and send back its error.
const MCP_CALL_TIMEOUT_MARGIN_MS = 15_000;
// Discovery waits for the proxy's token check, connect and tool list.
const MCP_DISCOVERY_TIMEOUT_MS = MCP_PROXY_DISCOVERY_MS + 10_000;

/** OpenCode's `mcp` timeout for a server: it bounds discovery and every call. */
export function opencodeMcpTimeoutMs(
  server: Pick<McpServerConfig, "timeoutMs"> | undefined,
): number {
  return Math.max(MCP_DISCOVERY_TIMEOUT_MS, (server?.timeoutMs ?? 0) + MCP_CALL_TIMEOUT_MARGIN_MS);
}

/** OpenCode's `mcp` entries: each server is the local proxy. */
export function opencodeMcpServers(runtime: McpProxyRuntime | undefined): Record<string, unknown> {
  return Object.fromEntries(
    [...(runtime?.commands ?? [])].map(([name, command]) => [
      name,
      // OpenCode applies `timeout` to discovery and to each tool call.
      // So it must outlast the proxy's own call deadline, or OpenCode cuts the call first.
      {
        type: "local",
        command,
        enabled: true,
        timeout: opencodeMcpTimeoutMs(runtime?.servers[name]),
      },
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
      return `  MCP server "${entry.server}" refused: its token is not a scoped token that expires, or it lacks a limit that requireNoNetwork or requireNoSudo asks for. Mint a scoped token for each review run.`;
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

/**
 * The OpenCode progress line for a tool named `<server>_<tool>`: `MCP <server>.<tool>`
 * when this pass may call it, "" (log nothing) when it may not, and undefined for a
 * tool of no configured server. Never the part's title, which can hold the tool input.
 */
export function opencodeMcpActivity(
  servers: Record<string, McpServerConfig> | undefined,
  agentId: string,
  opencodeTool: string,
): string | undefined {
  // The schema refuses a server name that starts with another's name and `_`, so at
  // most one server matches.
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!opencodeTool.startsWith(`${name}_`)) {
      continue;
    }
    const tool = opencodeTool.slice(name.length + 1);
    return server.agents.includes(agentId) && server.tools.includes(tool)
      ? `MCP ${name}.${tool}`
      : "";
  }
  return undefined;
}
