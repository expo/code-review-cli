import { test, expect } from "bun:test";

import {
  planFromAuth,
  exportLine,
  opencodeAuthJsonPath,
  accessTokenFromStore,
  opencodeLoginEnv,
  remainingLabel,
  superGrokTokenComplaint,
  SUPERGROK_LOGIN_ARGS,
} from "../commands/setup-auth.js";

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

test("plan: xAI oauth is a SuperGrok login and an xAI API key stays manual", () => {
  const oauth = planFromAuth([
    { provider: "xai", mode: "oauth", tokenEnv: "XAI_OAUTH_ACCESS_TOKEN" },
  ]);
  expect(oauth.grokLogin).toEqual({ tokenEnv: "XAI_OAUTH_ACCESS_TOKEN" });
  expect(oauth.chatgptLogin).toBeUndefined();
  expect(oauth.manualKeys).toEqual([]);
  expect(oauth.unsupported).toEqual([]);

  // No tokenEnv: the review rejects this config, so setup-auth must not pretend
  // the export line is enough. Same rule as the openai oauth branch.
  const missing = planFromAuth([{ provider: "xai", mode: "oauth" }]);
  expect(missing.grokLogin).toBeUndefined();
  expect(missing.unsupported).toEqual([{ provider: "xai", mode: "oauth" }]);

  const key = planFromAuth([{ provider: "xai", mode: "api-key", tokenEnv: "XAI_API_KEY" }]);
  expect(key.grokLogin).toBeUndefined();
  expect(key.manualKeys).toEqual([
    { provider: "xai", tokenEnv: "XAI_API_KEY", upstream: undefined },
  ]);
  expect(key.unsupported).toEqual([]);
});

test("SuperGrok login args select the device method and skip the menus", () => {
  expect(SUPERGROK_LOGIN_ARGS).toEqual([
    "auth",
    "login",
    "-p",
    "xai",
    "-m",
    "SuperGrok Subscription",
  ]);
});

test("the xAI export line is the access token and never the refresh token", () => {
  const exp = Math.floor(Date.now() / 1000) + 5 * 3600;
  const access = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  const refresh = "refresh-secret-not-for-export";
  const stored = accessTokenFromStore({ xai: { type: "oauth", access, refresh } }, "xai");
  expect(stored?.token).toBe(access);
  const line = exportLine("XAI_OAUTH_ACCESS_TOKEN", stored!.token);
  expect(line).toContain(access);
  expect(line).not.toContain(refresh);
  expect(accessTokenFromStore({ xai: { type: "oauth", refresh } }, "xai")).toBeNull();
});

function superGrokJwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
}

test("a SuperGrok token is reused only when a review takes it without complaint", () => {
  const env = "XAI_OAUTH_ACCESS_TOKEN";
  expect(superGrokTokenComplaint(superGrokJwt(5 * 3600), env)).toBeNull();
  // The review names `ecr setup-auth` as the fix for each of these, so none may skip the sign-in.
  expect(superGrokTokenComplaint(superGrokJwt(-600), env)).toContain("EXPIRED");
  expect(superGrokTokenComplaint(superGrokJwt(60), env)).toContain("120 seconds");
  expect(superGrokTokenComplaint(superGrokJwt(90 * 60), env)).toContain("expires in");
  expect(superGrokTokenComplaint("x".repeat(80), env)).toContain("opaque");
});

test("the remaining label uses minutes under an hour", () => {
  const now = Date.now();
  expect(remainingLabel(now + 30_000, now)).toBe("1 more minute(s)");
  expect(remainingLabel(now + 20 * 60_000, now)).toBe("20 more minute(s)");
  expect(remainingLabel(now + 5 * 3_600_000, now)).toBe("5 more hour(s)");
  expect(remainingLabel(now + 3 * 86_400_000, now)).toBe("3 more day(s)");
});

test("export line is single-quoted so shells never expand the value", () => {
  expect(exportLine("CODEX_OAUTH_ACCESS_TOKEN", "abc$HOME!x")).toBe(
    "export CODEX_OAUTH_ACCESS_TOKEN='abc$HOME!x'",
  );
});

test("export line escapes a single quote in the value", () => {
  expect(exportLine("XAI_OAUTH_ACCESS_TOKEN", "a'; touch /tmp/pwned; '")).toBe(
    String.raw`export XAI_OAUTH_ACCESS_TOKEN='a'\''; touch /tmp/pwned; '\'''`,
  );
});

test("OpenCode logins keep project config off", () => {
  // The login cwd is the temp dir, and OpenCode reads config from the cwd and its parents.
  expect(opencodeLoginEnv({ PATH: "/usr/bin" })).toEqual({
    PATH: "/usr/bin",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  });
});

test("opencode auth.json path honors XDG_DATA_HOME and falls back to ~/.local/share", () => {
  expect(opencodeAuthJsonPath({ XDG_DATA_HOME: "/custom/data" })).toBe(
    "/custom/data/opencode/auth.json",
  );
  expect(opencodeAuthJsonPath({})).toContain("/.local/share/opencode/auth.json");
});
