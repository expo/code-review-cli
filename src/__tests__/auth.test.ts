import { test, expect } from "bun:test";

import {
  prepareAuth,
  checkProviderAuth,
  checkOauthTokenShape,
  oauthAuthJsonEntry,
  jwtExpiryMs,
} from "../core/auth.js";
import type { LoadedConfig } from "../config/schema.js";

// Internal auth is a LIST of entries; most tests exercise one credential, so the
// helper wraps a single entry (pass an array for mixed setups).
const cfg = (auth: unknown): LoadedConfig =>
  ({ auth: Array.isArray(auth) ? auth : [auth] }) as unknown as LoadedConfig;

test("checkProviderAuth: api-key is ready when the configured tokenEnv is set", () => {
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "google", tokenEnv: "MY_KEY" }), {
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
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "google", tokenEnv: "MY_KEY" }), {});
  expect(r.ok).toBe(false);
  expect(r.detail).toMatch(/MY_KEY/);
});

test("checkProviderAuth: oauth requires the token env to be set", () => {
  // A generic (non-anthropic) provider exercises the oauth branch — anthropic is
  // served by the CLI and takes its own branch regardless of mode.
  expect(
    checkProviderAuth(cfg({ mode: "oauth", provider: "google", tokenEnv: "OAUTH" }), {}).ok,
  ).toBe(false);
  expect(
    checkProviderAuth(cfg({ mode: "oauth", provider: "google", tokenEnv: "OAUTH" }), {
      // Must be a realistically-shaped token: the value is now validated too (see
      // checkOauthTokenShape), so a stub like "tok" fails as truncated.
      OAUTH: `oauth-token-${"x".repeat(90)}`,
    }).ok,
  ).toBe(true);
});

test("checkProviderAuth: forbidden tokenEnv is refused", () => {
  for (const tokenEnv of ["GITHUB_TOKEN", "BRAVE_SEARCH_API_KEY"]) {
    const r = checkProviderAuth(cfg({ mode: "api-key", provider: "anthropic", tokenEnv }), {
      [tokenEnv]: "secret",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/non-provider secret/);
  }
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

// ---- anthropic (always served by the Claude Code CLI) ----

test("checkProviderAuth: anthropic is ready with its tokenEnv set to an Anthropic token", () => {
  const r = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" }),
    { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"x".repeat(95)}` },
  );
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("token env CLAUDE_CODE_OAUTH_TOKEN is set");
});

test("checkProviderAuth: mode is irrelevant for anthropic — an oauth entry still hits the CLI path", () => {
  // Mode "oauth" would normally require a token-shape check, but anthropic is served
  // by the CLI regardless of mode: it takes the anthropic branch, not the oauth one.
  const r = checkProviderAuth(
    cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" }),
    { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"x".repeat(95)}` },
  );
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("via the Claude Code CLI");
});

test("checkProviderAuth: an anthropic tokenEnv holding a non-Anthropic value is refused (exfil guard)", () => {
  // A non-forbidden CI secret (e.g. SENTRY_AUTH_TOKEN) passes the FORBIDDEN and
  // cross-provider guards, but its value would be shipped to api.anthropic.com — a
  // value that can't authenticate there but can leak. Refuse on the value shape.
  const r = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "SENTRY_AUTH_TOKEN" }),
    { SENTRY_AUTH_TOKEN: "sntrys_deadbeefcafefeed" },
  );
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("does not hold an Anthropic credential");
  // An Anthropic API key ("sk-ant-api…") in the same env is accepted (covers both
  // oat OAuth and api-key shapes under one "sk-ant-" prefix).
  const apiKey = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "ECR_CLAUDE_TOKEN" }),
    { ECR_CLAUDE_TOKEN: `sk-ant-api03-${"y".repeat(95)}` },
  );
  expect(apiKey.ok).toBe(true);
});

test("checkProviderAuth: anthropic with no tokenEnv defers to the local `claude` login", () => {
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "anthropic" }), {});
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("local `claude` login");
});

test("checkProviderAuth: anthropic with a named-but-unset tokenEnv warns and falls back to the local login", () => {
  const r = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" }),
    {},
  );
  // Not fatal: startClaudeCode falls back to the machine's `claude` login and
  // fails fast itself when neither credential exists.
  expect(r.ok).toBe(true);
  expect(r.warning).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(r.warning).toContain("claude` login");
});

test("checkProviderAuth: FORBIDDEN + cross-provider guards still fire for an anthropic tokenEnv", () => {
  const forbidden = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "GITHUB_TOKEN" }),
    { GITHUB_TOKEN: "ghp_xxx" },
  );
  expect(forbidden.ok).toBe(false);
  expect(forbidden.detail).toContain("non-provider secret");
  const crossed = checkProviderAuth(
    cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "OPENAI_API_KEY" }),
    { OPENAI_API_KEY: "sk-proj-xxx" },
  );
  expect(crossed.ok).toBe(false);
  expect(crossed.detail).toContain("openai's");
});

// ---- Anthropic OAuth env is anthropic-owned (cross-provider guard) ----

test("checkProviderAuth: a non-anthropic entry naming CLAUDE_CODE_OAUTH_TOKEN is refused", () => {
  // The long-lived Claude Max/Team subscription token would otherwise be forwarded to
  // a FOREIGN provider (here openai) as its bearer — it is neither in FORBIDDEN nor a
  // PROVIDER_KEY_ENV value, so only the anthropic-owned guard catches it. The
  // scaffolded default CLAUDE_CODE_REVIEW_SHARED_API_TOKEN is anthropic-owned the
  // same way: it always holds an Anthropic credential (templates/config.jsonc).
  for (const tokenEnv of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_REVIEW_SHARED_API_TOKEN",
  ]) {
    const r = checkProviderAuth(cfg({ mode: "api-key", provider: "openai", tokenEnv }), {
      [tokenEnv]: `sk-ant-oat01-${"x".repeat(95)}`,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("anthropic's");
  }
});

test("checkProviderAuth: an anthropic entry naming CLAUDE_CODE_OAUTH_TOKEN is still allowed", () => {
  // The guard keys on OWNER≠provider, so anthropic's own use of its OAuth env passes.
  const r = checkProviderAuth(
    cfg({ mode: "oauth", provider: "anthropic", tokenEnv: "ANTHROPIC_AUTH_TOKEN" }),
    { ANTHROPIC_AUTH_TOKEN: `sk-ant-oat01-${"x".repeat(95)}` },
  );
  expect(r.ok).toBe(true);
});

test("checkProviderAuth: the scaffolded default setup (anthropic + shared token env) passes", () => {
  // The exact shape `ecr init` scaffolds (templates/config.jsonc) — anthropic owns
  // the shared env, so its own entry must not trip the ownership guard.
  const r = checkProviderAuth(
    cfg({ provider: "anthropic", tokenEnv: "CLAUDE_CODE_REVIEW_SHARED_API_TOKEN" }),
    { CLAUDE_CODE_REVIEW_SHARED_API_TOKEN: `sk-ant-oat01-${"x".repeat(95)}` },
  );
  expect(r.ok).toBe(true);
});

test("checkProviderAuth: an upstream=anthropic alias may name CLAUDE_CODE_OAUTH_TOKEN", () => {
  // upstream is anthropic, so the owner matches the upstream and the token is not
  // being sent to a foreign provider.
  const r = checkProviderAuth(
    cfg({
      mode: "api-key",
      provider: "myanthropic",
      upstream: "anthropic",
      tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    }),
    { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${"x".repeat(95)}` },
  );
  expect(r.ok).toBe(true);
});

// A config that routes every model to a provider, plus the auth block. Used to
// exercise the provider-in-use scoping (the bare `cfg` helper has no models, so it
// can't scope and considers every entry).
const cfgWithModels = (models: string[], auth: unknown): LoadedConfig =>
  ({
    agents: models.map((model, i) => ({ id: `a${i}`, model })),
    coordinator: { model: models[0] },
    auth: Array.isArray(auth) ? auth : [auth],
  }) as unknown as LoadedConfig;

test("checkProviderAuth: the shipped openai default does NOT block an all-anthropic config (claude-login fallback)", () => {
  // The migration the task cares about: switch every model to anthropic/… but leave
  // (or omit → default) the openai auth block. openai routes no model here, so its
  // missing key must not fail the run — the Claude Code CLI's own login serves it.
  const r = checkProviderAuth(
    cfgWithModels(["anthropic/claude-opus-5"], { mode: "api-key", provider: "openai" }),
    {}, // no OPENAI_API_KEY, no ANTHROPIC_API_KEY, no claude token
  );
  expect(r.ok).toBe(true);
  expect(r.detail).not.toContain("OPENAI_API_KEY");
});

test("checkProviderAuth: an entry for an IN-USE provider is still enforced", () => {
  // Scoping must not become a blanket bypass: openai routes a model here, so its
  // missing credential still fails fast.
  const r = checkProviderAuth(
    cfgWithModels(["openai/gpt-5.5"], { mode: "api-key", provider: "openai" }),
    {},
  );
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("openai");
});

test("checkProviderAuth: Meta uses META_API_KEY and rejects cross-provider reuse", () => {
  const meta = cfgWithModels(["meta/muse-spark-1.2"], {
    mode: "api-key",
    provider: "meta",
    tokenEnv: "META_API_KEY",
  });
  expect(checkProviderAuth(meta, {}).detail).toContain("META_API_KEY");
  expect(checkProviderAuth(meta, { META_API_KEY: "meta-review-key" }).ok).toBe(true);

  const wrongOwner = cfgWithModels(["openai/gpt-5.5"], {
    mode: "api-key",
    provider: "openai",
    tokenEnv: "META_API_KEY",
  });
  const result = checkProviderAuth(wrongOwner, { META_API_KEY: "meta-review-key" });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("meta's well-known credential env");
});

test("prepareAuth: does not forward a dead unused-provider api-key into its key env", async () => {
  // An entry for a provider no model uses must not have its tokenEnv copied into the
  // provider key env — checkProviderAuth skips its guard, so forwarding would
  // reintroduce the secret-forwarding the guard prevents.
  const hadOpenai = process.env.OPENAI_API_KEY;
  const hadCustom = process.env.CUSTOM_OPENAI;
  delete process.env.OPENAI_API_KEY;
  process.env.CUSTOM_OPENAI = "sk-should-not-be-forwarded";
  try {
    const prepared = await prepareAuth(
      cfgWithModels(["anthropic/claude-opus-5"], {
        mode: "api-key",
        provider: "openai",
        tokenEnv: "CUSTOM_OPENAI",
      }),
    );
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    await prepared.cleanup();
  } finally {
    if (hadOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = hadOpenai;
    if (hadCustom === undefined) delete process.env.CUSTOM_OPENAI;
    else process.env.CUSTOM_OPENAI = hadCustom;
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
  process.env.ECR_TEST_GOOG = `oauth-access-${"x".repeat(90)}`;
  try {
    const prepared = await prepareAuth(
      cfg([
        { mode: "oauth", provider: "openai", tokenEnv: "ECR_TEST_CODEX" },
        // A non-openai oauth provider (anthropic is claude-engine-only and never
        // written to auth.json, so use another provider to cover the access shape).
        { mode: "oauth", provider: "google", tokenEnv: "ECR_TEST_GOOG" },
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
    // other providers: the token IS the access credential, far-future expiry.
    expect(written.google.access).toBe(process.env.ECR_TEST_GOOG);
    expect(written.google.refresh).toBe("");
    expect(written.google.expires).toBeGreaterThan(Date.now());
    await prepared.cleanup();
  } finally {
    delete process.env.ECR_TEST_CODEX;
    delete process.env.ECR_TEST_GOOG;
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

test("checkProviderAuth rejects a malformed anthropic token end to end (exfil guard)", () => {
  // A mangled paste (leading "sk-" dropped) no longer starts with "sk-ant-", so the
  // anthropic branch's exfil guard refuses it before a run — same "rejected up front"
  // guarantee as before, via the value-shape check the CLI path uses. (The mangled-
  // paste "missing sk-" heuristic itself is unit-tested via checkOauthTokenShape.)
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "OAUTH" }), {
    OAUTH: "ant-oat01-" + "x".repeat(90),
  });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("does not hold an Anthropic credential");
});

test("checkProviderAuth accepts a well-formed anthropic token", () => {
  const r = checkProviderAuth(cfg({ mode: "api-key", provider: "anthropic", tokenEnv: "OAUTH" }), {
    OAUTH: OAUTH,
  });
  expect(r.ok).toBe(true);
});

test("a well-known provider key env may only feed that provider", () => {
  // The tokenEnv guard locks NAMES; this closes the mapping hole — a PR keeping the
  // locked name but pointing its provider/upstream elsewhere would send one
  // provider's key to a different provider.
  const redirected = checkProviderAuth(
    cfg({
      mode: "api-key",
      provider: "openai-api",
      tokenEnv: "OPENAI_API_KEY",
      upstream: "anthropic",
    }),
    { OPENAI_API_KEY: "sk-proj-xxx" },
  );
  expect(redirected.ok).toBe(false);
  expect(redirected.detail).toContain("openai's");
  // …while the legitimate mappings stay allowed: the provider itself…
  expect(
    checkProviderAuth(cfg({ mode: "api-key", provider: "openai", tokenEnv: "OPENAI_API_KEY" }), {
      OPENAI_API_KEY: "sk-proj-xxx",
    }).ok,
  ).toBe(true);
  // …and an alias whose UPSTREAM owns the key env.
  expect(
    checkProviderAuth(
      cfg({
        mode: "api-key",
        provider: "openai-api",
        tokenEnv: "OPENAI_API_KEY",
        upstream: "openai",
      }),
      { OPENAI_API_KEY: "sk-proj-xxx" },
    ).ok,
  ).toBe(true);
});

// ---- access-token support (rotation-safe subscription credentials) ----

test("a JWT access token is used as-is with its own expiry — never refreshed", () => {
  // Refresh tokens are SINGLE-USE: sharing one as a static secret killed the
  // whole sign-in (euxy#8, "Your refresh token has already been used"). An
  // access token is a plain bearer with no rotation involvement.
  const exp = Math.floor(Date.now() / 1000) + 5 * 24 * 3600;
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  const entry = oauthAuthJsonEntry("openai", jwt);
  expect(entry).toEqual({ type: "oauth", access: jwt, refresh: "", expires: exp * 1000 });
  // An opaque token is still treated as a refresh token (sole-consumer setups).
  const opaque = oauthAuthJsonEntry("openai", "r".repeat(196));
  expect(opaque).toEqual({ type: "oauth", access: "", refresh: "r".repeat(196), expires: 0 });
});

test("an EXPIRED access token fails fast with the re-mint instruction", () => {
  const exp = Math.floor(Date.now() / 1000) - 2 * 24 * 3600;
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  const r = checkProviderAuth(cfg({ mode: "oauth", provider: "openai", tokenEnv: "TOK" }), {
    TOK: jwt,
  });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("EXPIRED");
  expect(r.detail).toContain("setup-auth");
});

test("a nearly-expired access token warns but never blocks", () => {
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12h left
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  const r = checkProviderAuth(cfg({ mode: "oauth", provider: "openai", tokenEnv: "TOK" }), {
    TOK: jwt,
  });
  expect(r.ok).toBe(true);
  expect(r.warning).toContain("expires in");
});

test("jwtExpiryMs decodes exp and tolerates garbage", () => {
  expect(jwtExpiryMs("not-a-jwt")).toBeNull();
  expect(jwtExpiryMs("eyJ.%%%.sig")).toBeNull();
  const jwt = `eyJ.${Buffer.from(JSON.stringify({ exp: 1000 })).toString("base64url")}.s`;
  expect(jwtExpiryMs(jwt)).toBe(1000_000);
});
