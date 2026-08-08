// @ref LLP 0013#one-package-two-binaries [implements] — the bounded MCP's environment is constructed, never inherited
/**
 * The single definition of what the bounded documentation MCP is allowed to see
 * in its environment.
 *
 * Two callers share it, and they need it for different reasons:
 *
 *  - `createResearchMcpRuntime` writes `researchChildEnvironment()` into the
 *    engine's MCP configuration. That block is a REQUEST, not a guarantee: both
 *    Claude Code and OpenCode merge it onto the environment the engine already
 *    has rather than replacing it, so the declared allowlist alone never bounds
 *    the child.
 *  - `wrapper.ts` applies `researchWrapperEnvironment()` when it spawns the real
 *    server. That IS the guarantee — the server process is handed a constructed
 *    environment, so whatever the engine merged in stops at the wrapper.
 *
 * Nothing here imports a parser, a network client, or the config schema: the
 * wrapper must stay loadable without pulling untrusted-content machinery into
 * the one process that still holds the engine's credentials.
 */

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export const RESEARCH_SEARCH_API_KEY = "BRAVE_SEARCH_API_KEY";

/**
 * Bounds ECR sets on the child through the config env block. These are inputs to
 * the server, so the wrapper must forward them; every one is a number, a path ECR
 * itself chose, or both, and none is a credential.
 */
export const RESEARCH_RUNTIME_ENV_KEYS = [
  "REVIEW_RESEARCH_AUDIT_PATH",
  "REVIEW_RESEARCH_INDEX_PATH",
  "REVIEW_RESEARCH_MAX_CALLS",
  "REVIEW_RESEARCH_MAX_RESULTS",
  "REVIEW_RESEARCH_TIMEOUT_MS",
] as const;

/**
 * Locale, proxy configuration, and the search-only credential — the environment
 * the MCP actually needs to do its job.
 *
 * NODE_OPTIONS is deliberately absent: it is arbitrary code injection into the
 * process that parses untrusted remote documents. So are PATH and HOME — the
 * wrapper spawns the server by absolute path and the server writes only to the
 * audit path it is given.
 */
export function researchChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(process.platform === "win32" && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
  };
  for (const key of PROXY_ENV_KEYS) {
    if (source[key]) environment[key] = source[key];
  }
  if (source[RESEARCH_SEARCH_API_KEY]) {
    environment[RESEARCH_SEARCH_API_KEY] = source[RESEARCH_SEARCH_API_KEY];
  }
  return environment;
}

/** The child environment plus the bounds ECR passes through the config block. */
export function researchWrapperEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = researchChildEnvironment(source);
  for (const key of RESEARCH_RUNTIME_ENV_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}
