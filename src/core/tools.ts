/** The OpenCode tool names the reviewer toggles. Single source of truth so the
 * agent and coordinator tool maps can't drift apart. */
export const OPENCODE_RESEARCH_TOOLS = [
  "platform_docs_search_platform_docs",
  "platform_docs_fetch_platform_doc",
] as const;

export const TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "list",
  "bash",
  "write",
  "edit",
  "patch",
  ...OPENCODE_RESEARCH_TOOLS,
] as const;

/** Build a full tool map with only the listed tools enabled. */
export function toolMap(enabled: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(TOOL_NAMES.map((name) => [name, enabled.includes(name)]));
}
