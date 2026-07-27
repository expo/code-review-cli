import { test, expect } from "bun:test";

import { prepareAuth, checkProviderAuth, checkOauthTokenShape } from "../core/auth.js";
import type { LoadedConfig } from "../config/schema.js";

// Internal auth is a LIST of entries; most tests exercise one credential, so the
// helper wraps a single entry (pass an array for mixed setups).
const cfg = (auth: unknown): LoadedConfig =>
  ({ auth: Array.isArray(auth) ? auth : [auth] }) as unknown as LoadedConfig;

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

// ---- multi-provider auth (mixed subscription + API key) ----

test("checkProviderAuth: every entry must be ready — one broken credential fails the run", () => {
  const entries = [
    { mode: "oauth", provider: "openai", tokenEnv: "CODEX_TOKEN" },
    { mode: "api-key", provider: "openai-api", tokenEnv: "OPENAI_API_KEY", upstream: "openai" },
  ];
  const bothSet = checkProviderAuth(cfg(entries), {
    CODEX_TOKEN: "r".repeat(60),
    OPENAI_API_KEY: "sk-proj-xxx",
  });
  expect(bothSet.ok).toBe(true);
  // The alias's key missing must fail fast — its passes would silently fail mid-run.
  const oneMissing = checkProviderAuth(cfg(entries), { CODEX_TOKEN: "r".repeat(60) });
  expect(oneMissing.ok).toBe(false);
  expect(oneMissing.detail).toContain("OPENAI_API_KEY");
});

test("checkProviderAuth: an upstream alias requires its tokenEnv (no ambient fallback)", () => {
  // A provider id we invented has no well-known key env; relying on OpenCode's
  // login can't work either, so absence is a hard failure.
  const r = checkProviderAuth(
    cfg({ mode: "api-key", provider: "openai-api", upstream: "openai" }),
    { OPENAI_API_KEY: "sk-proj-xxx" },
  );
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("upstream openai");
});

test("prepareAuth writes provider-shaped oauth entries into one isolated auth.json", async () => {
  const prevModel = process.env.REVIEWER_MODEL;
  const prevXdg = process.env.XDG_DATA_HOME;
  delete process.env.REVIEWER_MODEL;
  process.env.ECR_TEST_CODEX = "refresh-token-".padEnd(60, "r");
  process.env.ECR_TEST_ANT = `sk-ant-oat01-${"x".repeat(95)}`;
  try {
    const prepared = await prepareAuth(
      cfg([
        { mode: "oauth", provider: "openai", tokenEnv: "ECR_TEST_CODEX" },
        { mode: "oauth", provider: "anthropic", tokenEnv: "ECR_TEST_ANT" },
      ]),
    );
    const written = JSON.parse(
      await Bun.file(`${process.env.XDG_DATA_HOME}/opencode/auth.json`).text(),
    );
    // openai: the durable secret is the REFRESH token; expires 0 makes the codex
    // plugin mint a fresh access token on first request (access tokens live ~1h,
    // shorter than a worst-case run).
    expect(written.openai).toEqual({
      type: "oauth",
      access: "",
      refresh: process.env.ECR_TEST_CODEX,
      expires: 0,
    });
    // anthropic-style: the token IS the access credential, far-future expiry.
    expect(written.anthropic.access).toBe(process.env.ECR_TEST_ANT);
    expect(written.anthropic.refresh).toBe("");
    expect(written.anthropic.expires).toBeGreaterThan(Date.now());
    await prepared.cleanup();
  } finally {
    delete process.env.ECR_TEST_CODEX;
    delete process.env.ECR_TEST_ANT;
    if (prevModel === undefined) {
      delete process.env.REVIEWER_MODEL;
    } else {
      process.env.REVIEWER_MODEL = prevModel;
    }
    if (prevXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prevXdg;
    }
  }
});

test("prepareAuth: an upstream alias does not clobber the provider key env", async () => {
  // The alias's key is read via {env:tokenEnv} in the synthesized provider block;
  // copying it into OPENAI_API_KEY would hijack the real "openai" provider (which
  // may be oauth-backed) — so prepareAuth must leave the env alone.
  const prevModel = process.env.REVIEWER_MODEL;
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.REVIEWER_MODEL;
  process.env.ECR_TEST_ALIAS_KEY = "sk-proj-".padEnd(50, "k");
  delete process.env.OPENAI_API_KEY;
  try {
    const prepared = await prepareAuth(
      cfg([
        {
          mode: "api-key",
          provider: "openai-api",
          tokenEnv: "ECR_TEST_ALIAS_KEY",
          upstream: "openai",
        },
      ]),
    );
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    await prepared.cleanup();
  } finally {
    delete process.env.ECR_TEST_ALIAS_KEY;
    if (prevModel !== undefined) {
      process.env.REVIEWER_MODEL = prevModel;
    }
    if (prevKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevKey;
    }
  }
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
