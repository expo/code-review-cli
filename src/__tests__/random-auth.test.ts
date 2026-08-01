import { test, expect } from "bun:test";

import { ReviewConfigSchema } from "../config/schema.js";
import type { LoadedConfig } from "../config/schema.js";
import { normalizeAuth, tokenEnvMismatch } from "../config/load.js";
import { checkAuthEntry, prepareAuth } from "../core/auth.js";
import { effectiveConcurrency } from "../core/review.js";
import { planFromAuth } from "../commands/setup-auth.js";

const pickApiKey = (): number => 0.25; // rng < 0.5 ⇒ api-key
const pickOauth = (): number => 0.75; // rng ≥ 0.5 ⇒ oauth

// A plausibly-shaped opaque oauth token (≥ 40 chars, no whitespace).
const OAUTH_TOKEN = `oauth-token-${"x".repeat(90)}`;

// ---- schema ----

test("schema: mode random with both env names parses (providers map + legacy)", () => {
  const map = ReviewConfigSchema.safeParse({
    auth: {
      providers: {
        openai: { mode: "random", apiKeyEnv: "OPENAI_API_KEY", oauthTokenEnv: "CODEX_TOKEN" },
      },
    },
  });
  expect(map.success).toBe(true);
  const legacy = ReviewConfigSchema.safeParse({
    auth: {
      mode: "random",
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      oauthTokenEnv: "CODEX_TOKEN",
    },
  });
  expect(legacy.success).toBe(true);
});

test("schema: mode random without both env names is rejected", () => {
  const missing = ReviewConfigSchema.safeParse({
    auth: { providers: { openai: { mode: "random", apiKeyEnv: "OPENAI_API_KEY" } } },
  });
  expect(missing.success).toBe(false);
});

test("schema: mode random cannot ride an upstream alias", () => {
  const aliased = ReviewConfigSchema.safeParse({
    auth: {
      providers: {
        "openai-api": {
          mode: "random",
          apiKeyEnv: "A",
          oauthTokenEnv: "B",
          upstream: "openai",
        },
      },
    },
  });
  expect(aliased.success).toBe(false);
});

// ---- normalizeAuth resolution ----

test("normalizeAuth: random resolves per the coin flip and marks the entry", () => {
  const raw = {
    providers: {
      openai: {
        mode: "random" as const,
        apiKeyEnv: "OPENAI_API_KEY",
        oauthTokenEnv: "CODEX_TOKEN",
      },
    },
  };
  const apiKeyArm = normalizeAuth(raw, pickApiKey)[0]!;
  expect(apiKeyArm.mode).toBe("api-key");
  expect(apiKeyArm.tokenEnv).toBe("OPENAI_API_KEY");
  expect(apiKeyArm.randomized).toBe(true);

  const oauthArm = normalizeAuth(raw, pickOauth)[0]!;
  expect(oauthArm.mode).toBe("oauth");
  expect(oauthArm.tokenEnv).toBe("CODEX_TOKEN");
  expect(oauthArm.randomized).toBe(true);
});

test("normalizeAuth: fixed mode prefers the mode-specific env over tokenEnv", () => {
  const entry = normalizeAuth({
    mode: "oauth",
    provider: "openai",
    tokenEnv: "LEGACY",
    oauthTokenEnv: "CODEX_TOKEN",
  })[0]!;
  expect(entry.mode).toBe("oauth");
  expect(entry.tokenEnv).toBe("CODEX_TOKEN");
  expect(entry.randomized).toBeUndefined();
});

test("normalizeAuth: fixed mode without mode-specific envs keeps tokenEnv (back-compat)", () => {
  const entry = normalizeAuth({ mode: "api-key", provider: "openai", tokenEnv: "MY_KEY" })[0]!;
  expect(entry.tokenEnv).toBe("MY_KEY");
});

// ---- fail-fast: both credentials required, but ONLY for randomized entries ----

test("checkAuthEntry: randomized entry requires BOTH credentials in the env", () => {
  const entry = normalizeAuth(
    {
      providers: {
        openai: {
          mode: "random" as const,
          apiKeyEnv: "OPENAI_API_KEY",
          oauthTokenEnv: "CODEX_TOKEN",
        },
      },
    },
    pickApiKey,
  )[0]!;
  // Missing the OTHER arm's credential fails, even though the picked arm is set.
  const missingOauth = checkAuthEntry(entry, { OPENAI_API_KEY: "sk-xxx" });
  expect(missingOauth.ok).toBe(false);
  expect(missingOauth.detail).toMatch(/CODEX_TOKEN/);
  expect(missingOauth.detail).toMatch(/oauth arm/);

  const bothSet = checkAuthEntry(entry, {
    OPENAI_API_KEY: "sk-xxx",
    CODEX_TOKEN: OAUTH_TOKEN,
  });
  expect(bothSet.ok).toBe(true);
  expect(bothSet.detail).toMatch(/randomized/);
});

test("checkAuthEntry: fixed modes keep the single-credential check", () => {
  // Only the active mode's credential is required when the mode is pinned.
  const entry = normalizeAuth({
    mode: "api-key",
    provider: "openai",
    tokenEnv: "OPENAI_API_KEY",
  })[0]!;
  expect(checkAuthEntry(entry, { OPENAI_API_KEY: "sk-xxx" }).ok).toBe(true);
});

test("checkAuthEntry: deny checks cover BOTH declared env names", () => {
  // A forbidden secret in the arm the flip did NOT pick must still be refused.
  const entry = normalizeAuth(
    {
      providers: {
        openai: {
          mode: "random" as const,
          apiKeyEnv: "OPENAI_API_KEY",
          oauthTokenEnv: "GITHUB_TOKEN",
        },
      },
    },
    pickApiKey, // resolves tokenEnv to OPENAI_API_KEY; GITHUB_TOKEN is the other arm
  )[0]!;
  const refused = checkAuthEntry(entry, { OPENAI_API_KEY: "sk-xxx", GITHUB_TOKEN: "ghp" });
  expect(refused.ok).toBe(false);
  expect(refused.detail).toMatch(/GITHUB_TOKEN/);
});

test("checkAuthEntry: cross-provider ownership guard covers both declared names", () => {
  const entry = normalizeAuth(
    {
      providers: {
        google: {
          mode: "random" as const,
          apiKeyEnv: "OPENAI_API_KEY", // openai's well-known env on a google entry
          oauthTokenEnv: "GOOGLE_OAUTH",
        },
      },
    },
    pickOauth,
  )[0]!;
  const refused = checkAuthEntry(entry, {
    OPENAI_API_KEY: "sk-xxx",
    GOOGLE_OAUTH: OAUTH_TOKEN,
  });
  expect(refused.ok).toBe(false);
  expect(refused.detail).toMatch(/OPENAI_API_KEY/);
});

// ---- equalized concurrency ----

test("effectiveConcurrency: a randomized entry pins 3 on BOTH arms", () => {
  const config = (auth: unknown[]): LoadedConfig =>
    ({
      auth,
      chunk: {},
      agents: [{ model: "openai/gpt-5.5" }],
      coordinator: { model: "openai/gpt-5.5" },
    }) as unknown as LoadedConfig;
  const raw = {
    providers: {
      openai: {
        mode: "random" as const,
        apiKeyEnv: "OPENAI_API_KEY",
        oauthTokenEnv: "CODEX_TOKEN",
      },
    },
  };
  expect(effectiveConcurrency(config(normalizeAuth(raw, pickApiKey)), {})).toBe(3);
  expect(effectiveConcurrency(config(normalizeAuth(raw, pickOauth)), {})).toBe(3);
  // A pinned api-key entry keeps 6 (no experiment, no cap).
  expect(
    effectiveConcurrency(
      config(normalizeAuth({ mode: "api-key", provider: "openai", tokenEnv: "K" })),
      {},
    ),
  ).toBe(6);
});

// ---- CI auth lock ----

test("tokenEnvMismatch: the lock covers both declared names, stable across flips", () => {
  const raw = {
    providers: {
      openai: {
        mode: "random" as const,
        apiKeyEnv: "OPENAI_API_KEY",
        oauthTokenEnv: "CODEX_TOKEN",
      },
    },
  };
  const expected = "OPENAI_API_KEY,CODEX_TOKEN";
  expect(tokenEnvMismatch(normalizeAuth(raw, pickApiKey), expected)).toBeNull();
  expect(tokenEnvMismatch(normalizeAuth(raw, pickOauth), expected)).toBeNull();
  expect(tokenEnvMismatch(normalizeAuth(raw, pickOauth), "OPENAI_API_KEY")).toMatch(/CODEX_TOKEN/);
});

// ---- setup-auth plans both arms ----

test("planFromAuth: a randomized openai entry plans the ChatGPT login AND the API key", () => {
  const raw = {
    providers: {
      openai: {
        mode: "random" as const,
        apiKeyEnv: "OPENAI_API_KEY",
        oauthTokenEnv: "CODEX_TOKEN",
      },
    },
  };
  // Whichever arm the flip picked, BOTH credentials get provisioned.
  for (const rng of [pickApiKey, pickOauth]) {
    const plan = planFromAuth(normalizeAuth(raw, rng));
    expect(plan.chatgptLogin).toEqual({ tokenEnv: "CODEX_TOKEN" });
    expect(plan.manualKeys).toEqual([
      { provider: "openai", tokenEnv: "OPENAI_API_KEY", upstream: undefined },
    ]);
  }
});

// ---- prepareAuth: ambient key scrubbed on the oauth arm, restored by cleanup ----

test("prepareAuth: the oauth arm scrubs the ambient API key and cleanup restores it", async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedToken = process.env.CODEX_TOKEN;
  const savedXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.OPENAI_API_KEY = "sk-ambient";
    process.env.CODEX_TOKEN = OAUTH_TOKEN;
    delete process.env.REVIEWER_MODEL;
    const entry = normalizeAuth(
      {
        providers: {
          openai: {
            mode: "random" as const,
            apiKeyEnv: "OPENAI_API_KEY",
            oauthTokenEnv: "CODEX_TOKEN",
          },
        },
      },
      pickOauth,
    )[0]!;
    const config = {
      auth: [entry],
      agents: [{ model: "openai/gpt-5.5" }],
      coordinator: { model: "openai/gpt-5.5" },
    } as unknown as LoadedConfig;
    const prepared = await prepareAuth(config);
    // The key env must be GONE while the oauth arm runs (it could silently serve
    // the requests and relabel api-key behavior as oauth).
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    await prepared.cleanup();
    // …and back afterwards, so a later scope run's own flip can use it.
    expect(process.env.OPENAI_API_KEY).toBe("sk-ambient");
  } finally {
    if (savedKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedKey;
    }
    if (savedToken === undefined) {
      delete process.env.CODEX_TOKEN;
    } else {
      process.env.CODEX_TOKEN = savedToken;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedXdg;
    }
  }
});
