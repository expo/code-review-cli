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

test("plan: anthropic oauth is unsupported (dead path), api-key without tokenEnv needs nothing", () => {
  const plan = planFromAuth([
    { provider: "anthropic", mode: "oauth", tokenEnv: "ANTHROPIC_OAUTH_API_KEY" },
    // Relies on OpenCode's own login — nothing for setup-auth to do.
    { provider: "openai", mode: "api-key" },
  ]);
  expect(plan.chatgptLogin).toBeUndefined();
  expect(plan.manualKeys).toEqual([]);
  expect(plan.unsupported).toHaveLength(1);
  expect(plan.unsupported[0]?.provider).toBe("anthropic");
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
