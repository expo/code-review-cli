// @ref LLP 0003#configured-mcp-servers [implements] — root-only remote MCP servers, granted per pass, token by env var name
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { McpServerConfig } from "../config/schema.js";
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

/**
 * One owner-only Claude config per server. The header names the env var and Claude
 * Code expands it, so the token is never written to disk.
 */
export async function writeClaudeMcpServerConfigs(
  servers: Record<string, McpServerConfig>,
  dir: string,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  for (const [name, server] of Object.entries(servers)) {
    const file = path.join(dir, `${name}.json`);
    const entry = {
      type: "http",
      url: server.url,
      ...(server.tokenEnv ? { headers: { Authorization: `Bearer \${${server.tokenEnv}}` } } : {}),
    };
    await writeFile(file, `${JSON.stringify({ mcpServers: { [name]: entry } })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    paths.set(name, file);
  }
  return paths;
}

/** OpenCode's `mcp` entries for the servers, with `{env:…}` resolved by OpenCode. */
export function opencodeMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).map(([name, server]) => [
      name,
      {
        type: "remote",
        url: server.url,
        ...(server.tokenEnv
          ? { headers: { Authorization: `Bearer {env:${server.tokenEnv}}` } }
          : {}),
        oauth: false,
        enabled: true,
      },
    ]),
  );
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
