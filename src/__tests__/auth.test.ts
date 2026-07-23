import { test, expect } from "bun:test";

import { prepareAuth, checkProviderAuth } from "../core/auth.js";
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
      OAUTH: "tok",
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
