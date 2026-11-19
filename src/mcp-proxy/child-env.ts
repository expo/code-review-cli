// @ref LLP 0003#configured-mcp-servers [implements] — the proxy's environment is built from an allowlist, never inherited
import { PROXY_ENV_KEYS } from "../research-mcp/child-env.js";

const TOKEN_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** The token env a settings file names, or undefined when it names none or a bad one. */
export function settingsTokenEnv(settingsText: string): string | undefined {
  try {
    const tokenEnv = (JSON.parse(settingsText) as { tokenEnv?: unknown } | null)?.tokenEnv;
    return typeof tokenEnv === "string" && TOKEN_ENV_PATTERN.test(tokenEnv) ? tokenEnv : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locale, network proxy settings, and the one token this server uses.
 * Both engines merge their own environment into an MCP child, so the wrapper builds
 * this one instead: the model key, GH_TOKEN and other servers' tokens stop there.
 */
export function mcpProxyChildEnvironment(
  source: NodeJS.ProcessEnv,
  tokenEnv: string | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(process.platform === "win32" && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
  };
  for (const key of PROXY_ENV_KEYS) {
    if (source[key]) environment[key] = source[key];
  }
  if (tokenEnv && source[tokenEnv]) {
    environment[tokenEnv] = source[tokenEnv];
  }
  return environment;
}
