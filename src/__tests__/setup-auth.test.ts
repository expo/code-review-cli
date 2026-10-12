import { test, expect } from "bun:test";

import { planFromAuth, exportLine, opencodeAuthJsonPath } from "../commands/setup-auth.js";

test("plan: the mixed setup needs one ChatGPT login and one manual key", () => {
  const plan = planFromAuth([
    { provider: "openai", mode: "oauth", tokenEnv: "CODEX_OAUTH_ACCESS_TOKEN" },
    { provider: "openai-api", mode: "api-key", tokenEnv: "OPENAI_API_KEY", upstream: "openai" },
  ]);
  expect(plan.chatgptLogin).toEqual({ tokenEnv: "CODEX_OAUTH_ACCESS_TOKEN" });
  expect(plan.manualKeys).toEqual([
    { provider: "openai-api", tokenEnv: "OPENAI_API_KEY", upstream: "openai" },
  ]);
  expect(plan.unsupported).toEqual([]);
});

test("plan: Meta Model API is a manual API key setup", () => {
  const plan = planFromAuth([{ provider: "meta", mode: "api-key", tokenEnv: "META_API_KEY" }]);
  expect(plan.manualKeys).toEqual([
    { provider: "meta", tokenEnv: "META_API_KEY", upstream: undefined },
  ]);
  expect(plan.unsupported).toEqual([]);
});

test("plan: an anthropic entry (any mode) → claudeLogin; api-key without tokenEnv needs nothing", () => {
  const plan = planFromAuth([
    // Mode is irrelevant for anthropic — it is always served by the Claude Code CLI.
    { provider: "anthropic", mode: "oauth", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
    // Relies on OpenCode's own login — nothing for setup-auth to do.
    { provider: "openai", mode: "api-key" },
  ]);
  expect(plan.claudeLogin).toEqual({ tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" });
  expect(plan.chatgptLogin).toBeUndefined();
  expect(plan.manualKeys).toEqual([]);
  expect(plan.unsupported).toEqual([]);
});

test("plan: an anthropic entry becomes a claudeLogin (default env when tokenEnv omitted)", () => {
  const explicit = planFromAuth([
    { provider: "anthropic", mode: "api-key", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
  ]);
  expect(explicit.claudeLogin).toEqual({ tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" });
  // No tokenEnv → the default env name, and it is not misfiled as a manual key.
  const defaulted = planFromAuth([{ provider: "anthropic", mode: "api-key" }]);
  expect(defaulted.claudeLogin).toEqual({ tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" });
  expect(defaulted.manualKeys).toEqual([]);
  expect(defaulted.unsupported).toEqual([]);
});

test("plan: an anthropic/… model triggers claudeLogin even with no anthropic auth entry", () => {
  // The engine is inferred from the model, so an anthropic model needs the Claude
  // subscription login even when the auth block names no anthropic entry.
  const plan = planFromAuth(
    [{ provider: "openai", mode: "api-key" }],
    ["anthropic/claude-opus-5", "openai/gpt-5.5"],
  );
  expect(plan.claudeLogin).toEqual({ tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" });
  expect(plan.unsupported).toEqual([]);
});

test("export line is single-quoted so shells never expand the value", () => {
  expect(exportLine("CODEX_OAUTH_ACCESS_TOKEN", "abc$HOME!x")).toBe(
    "export CODEX_OAUTH_ACCESS_TOKEN='abc$HOME!x'",
  );
});

test("opencode auth.json path honors XDG_DATA_HOME and falls back to ~/.local/share", () => {
  expect(opencodeAuthJsonPath({ XDG_DATA_HOME: "/custom/data" })).toBe(
    "/custom/data/opencode/auth.json",
  );
  expect(opencodeAuthJsonPath({})).toContain("/.local/share/opencode/auth.json");
});
