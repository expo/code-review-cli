import { test, expect } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseCiSeedArgs,
  superGrokLoginInTemporaryStore,
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

test("--ci-store selects the CI seed, and --ci-target may repeat", () => {
  expect(parseCiSeedArgs([])).toBeNull();
  expect(parseCiSeedArgs(["--yes"])).toBeNull();
  expect(parseCiSeedArgs(["--ci-store", "expo/code-review-sessions"])).toEqual({
    store: "expo/code-review-sessions",
    targets: [],
  });
  expect(
    parseCiSeedArgs([
      "--yes",
      "--ci-target",
      "expo/expo",
      "--ci-store",
      "expo/code-review-sessions",
      "--ci-target",
      "expo/eas-cli",
      "--ci-target",
      "expo/expo",
    ]),
  ).toEqual({ store: "expo/code-review-sessions", targets: ["expo/expo", "expo/eas-cli"] });
});

test("a CI seed flag with a missing or bad repository is a usage error", () => {
  expect(() => parseCiSeedArgs(["--ci-target", "expo/expo"])).toThrow(/needs --ci-store/);
  expect(() => parseCiSeedArgs(["--ci-store"])).toThrow(/--ci-store needs a repository/);
  expect(() => parseCiSeedArgs(["--ci-store", "--yes"])).toThrow(/--ci-store needs a repository/);
  expect(() => parseCiSeedArgs(["--ci-store", "a/b", "--ci-store", "c/d"])).toThrow(/one time/);
  expect(() => parseCiSeedArgs(["--ci-store", "not-a-repo"])).toThrow(/<owner>\/<repo>/);
  expect(() => parseCiSeedArgs(["--ci-store", "a/b", "--ci-target", "x"])).toThrow(
    /<owner>\/<repo>/,
  );
});

// Stands in for `opencode auth login`: records how it was called, then acts on FAKE_OPENCODE_MODE.
const FAKE_OPENCODE = `#!/bin/sh
{
  echo "argv=$*"
  echo "data=$XDG_DATA_HOME"
  echo "project_config_off=$OPENCODE_DISABLE_PROJECT_CONFIG"
} > "$FAKE_OPENCODE_DIR/call.log"
[ "$FAKE_OPENCODE_MODE" = "fail" ] && exit 3
[ "$FAKE_OPENCODE_MODE" = "nothing" ] && exit 0
mkdir -p "$XDG_DATA_HOME/opencode"
if [ "$FAKE_OPENCODE_MODE" = "norefresh" ]; then
  printf '{"xai":{"type":"oauth","access":"eyJ.SEED.sig","refresh":"","expires":1}}' > "$XDG_DATA_HOME/opencode/auth.json"
else
  printf '{"xai":{"type":"oauth","access":"eyJ.SEED.sig","refresh":"SEED-REFRESH","expires":1}}' > "$XDG_DATA_HOME/opencode/auth.json"
fi
`;

async function withFakeOpencode(
  mode: string,
  body: (cli: string, callLog: () => Promise<Record<string, string>>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ecr-fake-opencode-"));
  const cli = path.join(dir, "opencode");
  await writeFile(cli, FAKE_OPENCODE, "utf8");
  await chmod(cli, 0o755);
  const saved = {
    dir: process.env.FAKE_OPENCODE_DIR,
    mode: process.env.FAKE_OPENCODE_MODE,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.FAKE_OPENCODE_DIR = dir;
  process.env.FAKE_OPENCODE_MODE = mode;
  try {
    await body(cli, async () =>
      Object.fromEntries(
        (await readFile(path.join(dir, "call.log"), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
      ),
    );
    // The login must not move this process to the temporary store.
    expect(process.env.XDG_DATA_HOME).toBe(saved.xdg);
  } finally {
    for (const [name, value] of [
      ["FAKE_OPENCODE_DIR", saved.dir],
      ["FAKE_OPENCODE_MODE", saved.mode],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("the CI login runs in a store of its own and deletes that store", async () => {
  await withFakeOpencode("ok", async (cli, callLog) => {
    expect(await superGrokLoginInTemporaryStore(cli)).toEqual({
      access: "eyJ.SEED.sig",
      refresh: "SEED-REFRESH",
    });
    const call = await callLog();
    expect(call.argv).toBe("auth login -p xai -m SuperGrok Subscription");
    expect(call.project_config_off).toBe("1");
    expect(path.basename(call.data!)).toMatch(/^ecr-ci-seed-/);
    await expect(stat(call.data!)).rejects.toThrow();
  });
});

test("a CI login that fails or stores no token pair changes nothing and leaves no store", async () => {
  for (const [mode, message] of [
    ["fail", /exited with 3; nothing was changed/],
    ["nothing", /stored no SuperGrok access and refresh token/],
    ["norefresh", /stored no SuperGrok access and refresh token/],
  ] as const) {
    await withFakeOpencode(mode, async (cli, callLog) => {
      await expect(superGrokLoginInTemporaryStore(cli)).rejects.toThrow(message);
      await expect(stat((await callLog()).data!)).rejects.toThrow();
    });
  }
});
