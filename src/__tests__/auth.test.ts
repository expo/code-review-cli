import { test, expect } from "bun:test";

import { prepareAuth, checkProviderAuth, checkOauthTokenShape } from "../core/auth.js";
import type { LoadedConfig } from "../config/schema.js";

const cfg = (auth: unknown): LoadedConfig => ({ auth }) as unknown as LoadedConfig;

test("checkProviderAuth: api-key is ready when the configured tokenEnv is set", () => {
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "MY_KEY" }), {
    MY_KEY: "sk-xxx",
  });
  expect(r.ok).toBe(true);
});

test("checkProviderAuth: api-key is ready via the provider key env when no tokenEnv value", () => {
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "openai", tokenEnv: "MY_KEY" }), {
    OPENAI_API_KEY: "sk-xxx",
  });
  expect(r.ok).toBe(true);
});

test("checkProviderAuth: api-key fails fast when no credential is set anywhere", () => {
  const r = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "MY_KEY" }),
    {},
  );
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/MY_KEY/);
});

test("checkProviderAuth: oauth requires the token env to be set", () => {
  expect(
    checkProviderAuth(cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "OAUTH" }), {}).ok,
  ).toBe(false);
  expect(
    checkProviderAuth(cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "OAUTH" }), {
      // Must be a realistically-shaped token: the value is now validated too (see
      // checkOauthTokenShape), so a stub like "tok" fails as truncated.
      OAUTH: `sk-ant-oat01-${"x".repeat(90)}`,
    }).ok,
  ).toBe(true);
});

test("checkProviderAuth: forbidden tokenEnv is refused", () => {
  const r = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "GITHUB_TOKEN" }),
    {
      GITHUB_TOKEN: "ghp_xxx",
    },
  );
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/non-provider secret/);
});

test("checkProviderAuth: REVIEWER_MODEL override is always ready (own login)", () => {
  const r = checkProviderAuth(cfg({ mode: "oauth", provider: "anthropic" }), {
    REVIEWER_MODEL: "openai/some-model",
  });
  expect(r.ok).toBe(true);
});

test("checkProviderAuth: no tokenEnv and unknown provider defers to OpenCode login", () => {
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "mystery" }), {});
  expect(r.ok).toBe(true);
});

test("prepareAuth refuses to forward a well-known non-provider secret as tokenEnv", async () => {
  const prev = process.env.REVIEWER_MODEL;
  delete process.env.REVIEWER_MODEL; // ensure the guard path runs (override would skip it)
  try {
    await expect(
      prepareAuth(cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "GITHUB_TOKEN" })),
    ).rejects.toThrow(/non-provider secret/);
    await expect(
      prepareAuth(cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "AWS_SECRET_ACCESS_KEY" })),
    ).rejects.toThrow(/non-provider secret/);
  } finally {
    if (prev === undefined) {
      delete process.env.REVIEWER_MODEL;
    } else {
      process.env.REVIEWER_MODEL = prev;
    }
  }
});

test("prepareAuth: REVIEWER_MODEL override skips provider auth entirely (no throw)", async () => {
  const prev = process.env.REVIEWER_MODEL;
  process.env.REVIEWER_MODEL = "openai/some-model";
  try {
    // Even a forbidden tokenEnv is a no-op under the local override path.
    const prepared = await prepareAuth(
      cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "GITHUB_TOKEN" }),
    );
    await prepared.cleanup();
  } finally {
    if (prev === undefined) {
      delete process.env.REVIEWER_MODEL;
    } else {
      process.env.REVIEWER_MODEL = prev;
    }
  }
});

// ---- OAuth token shape ----
//
// A malformed token is refused by OpenCode in the most misleading way available: the
// provider vanishes from its provider list, so every configured model reports "model
// not found" and nothing mentions credentials. Catch the unusable shapes up front.

const OAUTH = "sk-ant-oat01-" + "x".repeat(90);

test("a well-formed OAuth token passes", () => {
  expect(checkOauthTokenShape("anthropic", OAUTH, "TOK").ok).toBe(true);
});

test("an OAuth token that lost its sk- prefix is rejected, and says so", () => {
  // The exact value that cost a debugging session: `ant-oat01-…`. Provably wrong,
  // because restoring the dropped "sk-" reproduces the documented shape exactly.
  const r = checkOauthTokenShape("anthropic", "ant-oat01-" + "x".repeat(90), "TOK");
  expect(r.ok).toBe(false);
  expect(r.detail).toContain('missing its leading "sk-"');
  expect(r.detail).toContain("claude setup-token");
});

test("an unrecognized shape only WARNS — a heuristic must not block a working setup", () => {
  // We cannot prove Anthropic never mints other shapes, so this must still run.
  const r = checkOauthTokenShape("anthropic", "sk-ant-somethingnew-" + "y".repeat(88), "TOK");
  expect(r.ok).toBe(true);
  expect(r.warning).toContain("does not start with");
});

test("a token unrelated to Anthropic's shapes warns rather than failing", () => {
  const r = checkOauthTokenShape("anthropic", "totally-different-" + "z".repeat(90), "TOK");
  expect(r.ok).toBe(true);
  expect(r.warning).toBeDefined();
});

test("a well-formed OAuth token produces no warning at all", () => {
  expect(checkOauthTokenShape("anthropic", OAUTH, "TOK").warning).toBeUndefined();
});

test("an API key in oauth mode is rejected with the mode to switch to", () => {
  const r = checkOauthTokenShape("anthropic", "sk-ant-api03-" + "x".repeat(95), "TOK");
  expect(r.ok).toBe(false);
  expect(r.detail).toContain('"api-key"');
});

test("a truncated token is rejected before its prefix is even considered", () => {
  const r = checkOauthTokenShape("anthropic", "sk-ant-oat01-short", "TOK");
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("truncated");
});

test("surrounding whitespace is rejected (the classic CI secret paste)", () => {
  const r = checkOauthTokenShape("anthropic", `${OAUTH}\n`, "TOK");
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("whitespace");
});

test("a future oat-family prefix is accepted cleanly (forward compatible)", () => {
  const r = checkOauthTokenShape("anthropic", "sk-ant-oat99-" + "y".repeat(90), "TOK");
  expect(r.ok).toBe(true);
  expect(r.warning).toBeUndefined();
});

test("formats of providers we do not know are never judged", () => {
  expect(checkOauthTokenShape("someprovider", "whatever-" + "z".repeat(90), "TOK").ok).toBe(true);
});

test("checkProviderAuth rejects a malformed oauth token end to end", () => {
  const r = checkProviderAuth(cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "OAUTH" }), {
    OAUTH: "ant-oat01-" + "x".repeat(90),
  });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain('missing its leading "sk-"');
});

test("checkProviderAuth accepts a well-formed oauth token", () => {
  const r = checkProviderAuth(cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "OAUTH" }), {
    OAUTH: OAUTH,
  });
  expect(r.ok).toBe(true);
});
