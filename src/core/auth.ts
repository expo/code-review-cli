// @ref LLP 0003#credential-resolution-and-forwarding [implements] — deny-list, cross-provider guard, isolated OAuth staging, and the forwarding-site recheck for Claude Code
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuthConfigEntry, LoadedConfig } from "../config/schema.js";

export interface PreparedAuth {
  cleanup: () => Promise<void>;
}

/** Env var each provider's SDK reads for an API key (x-api-key style). */
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  meta: "META_API_KEY",
};

/**
 * Provider-owned credential env vars BEYOND the x-api-key ones above: Anthropic's
 * OAuth/subscription bearer envs. CLAUDE_CODE_OAUTH_TOKEN holds the long-lived (1-year)
 * Claude Max/Team subscription token that `ecr setup-auth`/`claude setup-token` export,
 * ANTHROPIC_AUTH_TOKEN is Anthropic's documented bearer var, and
 * CLAUDE_CODE_REVIEW_SHARED_API_TOKEN is the SCAFFOLDED DEFAULT tokenEnv (see
 * templates/config.jsonc) — it always holds an Anthropic credential. They belong to
 * anthropic, so the cross-provider guard below refuses a non-anthropic entry that names
 * one — without this, `{provider:"openai", tokenEnv:"CLAUDE_CODE_OAUTH_TOKEN"}` passes
 * (neither a FORBIDDEN secret nor a PROVIDER_KEY_ENV value) and prepareAuth forwards the
 * Anthropic subscription token to a foreign provider as its bearer. They are NOT in
 * FORBIDDEN_TOKEN_ENVS because an anthropic entry may legitimately name them.
 */
const ANTHROPIC_TOKEN_ENVS: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "anthropic",
  ANTHROPIC_AUTH_TOKEN: "anthropic",
  CLAUDE_CODE_REVIEW_SHARED_API_TOKEN: "anthropic",
};

/**
 * Env vars that must NEVER be forwarded to a model provider. `auth.tokenEnv` names
 * the env var whose value becomes the provider credential — but that config is
 * loaded from the repo, and in the CI auto-review it can be PR-controlled. A PR
 * that pointed `tokenEnv` at one of these would exfiltrate that secret to the
 * external model provider. The provider credential must only ever be a token
 * minted for that provider, so we hard-refuse these well-known unrelated secrets.
 * Defense-in-depth alongside loading config only from the trusted base ref.
 */
export const FORBIDDEN_TOKEN_ENVS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "BRAVE_SEARCH_API_KEY",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCP_SERVICE_ACCOUNT_KEY",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "SSH_PRIVATE_KEY",
]);

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface AuthReadiness {
  /** True when the configured provider has (or plausibly has) a usable credential. */
  ok: boolean;
  /** Human-readable detail for `doctor` output and fail-fast error messages. */
  detail: string;
  /**
   * A credential that is suspicious but not provably broken. Reported by `doctor`,
   * never a reason to refuse a run — the shape rules below are heuristics, and a
   * heuristic must not block a setup that would have worked.
   */
  warning?: string;
}

/**
 * Documented Anthropic OAuth token shape: `sk-ant-oat01-` + 95 chars = 108 total
 * (what `claude setup-token` prints). Treated as a STRONG HINT, not a spec: it comes
 * from observed tokens and third-party sources, not an Anthropic format guarantee, so
 * an unrecognized shape only warns. The one exception is below — a value that becomes
 * exactly this shape by restoring a dropped `sk-` is provably a mangled paste.
 */
const ANTHROPIC_OAUTH_PREFIX = "sk-ant-oat";
/** Anthropic API keys — valid credentials, but for auth.mode "api-key", not "oauth". */
const ANTHROPIC_API_KEY_PREFIX = "sk-ant-api";
/** Shorter than any credential of any provider ⇒ truncated, whatever the format. */
const MIN_TOKEN_LENGTH = 40;

/**
 * Catch an OAuth token that CANNOT work before it costs a whole run.
 *
 * Motivation: OpenCode refuses a malformed credential by dropping the provider from
 * its provider list entirely, so every configured model then reports "model not
 * found" and nothing anywhere mentions credentials. That misdirection cost a full
 * debugging session for a value that had simply lost its leading `sk-`.
 *
 * The bar for `ok: false` is "this cannot be a valid credential", not "this looks
 * odd", because a false rejection blocks a working setup — a worse failure than the
 * one being prevented. Provable: whitespace, absurdly short, an API key in oauth
 * mode, and an OAuth token missing its `sk-`. Everything else is at most a warning,
 * and formats of providers we don't know are never judged at all.
 */
export function checkOauthTokenShape(
  provider: string,
  token: string,
  tokenEnv: string,
): AuthReadiness {
  const ok = { ok: true, detail: `oauth for ${provider}; token env ${tokenEnv} is set` };
  const fix = `Re-generate it with \`claude setup-token\` and set ${tokenEnv} to the full value.`;
  if (token !== token.trim()) {
    return {
      ok: false,
      detail:
        `${tokenEnv} has leading/trailing whitespace (a newline from a copy-paste or a ` +
        `\`cat\`-ed file is the usual cause); the provider will refuse it. ${fix}`,
    };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      detail: `${tokenEnv} holds only ${token.length} characters, too short to be a real ${provider} token — it looks truncated. ${fix}`,
    };
  }
  // A ChatGPT access token carries its own expiry — check it up front, so a
  // lapsed credential is one clear message instead of N failed passes, and a
  // nearly-lapsed one warns before it bites mid-run.
  if (provider === "openai" && isJwtAccessToken(token)) {
    const expires = jwtExpiryMs(token);
    if (expires !== null) {
      const remainingMs = expires - Date.now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          detail:
            `${tokenEnv} holds a ChatGPT access token that EXPIRED ${Math.ceil(-remainingMs / 86_400_000)} day(s) ago. ` +
            `Mint a fresh one (\`ecr setup-auth\`, or your token-rotator job) and update ${tokenEnv}.`,
        };
      }
      if (remainingMs < 3 * 86_400_000) {
        return {
          ...ok,
          detail: `oauth for ${provider}; token env ${tokenEnv} is set`,
          warning:
            `${tokenEnv}'s ChatGPT access token expires in ${Math.max(1, Math.round(remainingMs / 3_600_000))}h — ` +
            `re-mint it soon (\`ecr setup-auth\`, or your token-rotator job).`,
        };
      }
    }
    return { ...ok, detail: `oauth for ${provider}; token env ${tokenEnv} is set` };
  }

  // Only anthropic's formats are known well enough to say anything about.
  if (provider !== "anthropic") {
    return ok;
  }
  if (token.startsWith(ANTHROPIC_API_KEY_PREFIX)) {
    return {
      ok: false,
      detail:
        `${tokenEnv} holds an Anthropic API key ("${ANTHROPIC_API_KEY_PREFIX}…"), but auth.mode is ` +
        `"oauth", which expects the OAuth token from \`claude setup-token\` ` +
        `("${ANTHROPIC_OAUTH_PREFIX}…"). Either set auth.mode to "api-key" in ` +
        `.expo-code-review/config.jsonc, or put an OAuth token in ${tokenEnv}.`,
    };
  }
  // Provable mangled paste: prepending the dropped "sk-" yields exactly the documented
  // OAuth shape. Only this reconstruction earns a hard failure — the value is not a
  // credential of any known kind as it stands, but is one character-for-character with
  // its prefix restored.
  if (!token.startsWith("sk-") && `sk-${token}`.startsWith(ANTHROPIC_OAUTH_PREFIX)) {
    return {
      ok: false,
      detail:
        `${tokenEnv} starts with "${token.slice(0, 10)}…", which is an Anthropic OAuth token ` +
        `missing its leading "sk-" — the prefix was dropped when the value was copied ` +
        `(adding it back gives "${ANTHROPIC_OAUTH_PREFIX}…", the shape \`claude setup-token\` ` +
        `prints). OpenCode refuses a malformed credential by dropping the provider entirely, ` +
        `which then surfaces as "model not found" for every model. ${fix}`,
    };
  }
  if (!token.startsWith(ANTHROPIC_OAUTH_PREFIX)) {
    // Unrecognized, but we can't prove it's wrong: Anthropic can mint shapes we don't
    // know, so advise and continue rather than refusing to run.
    return {
      ...ok,
      warning:
        `${tokenEnv} does not start with "${ANTHROPIC_OAUTH_PREFIX}…" (the shape ` +
        `\`claude setup-token\` prints for auth.mode "oauth"). It may still be valid — but if ` +
        `the run fails with "model not found" for every model, the credential was refused, ` +
        `and this is the first thing to check.`,
    };
  }
  return ok;
}

// @ref LLP 0003#credential-resolution-and-forwarding [implements] — two deny checks: FORBIDDEN_TOKEN_ENVS refuses well-known unrelated secrets; the cross-provider ownership guard refuses a non-anthropic entry naming an ANTHROPIC_TOKEN_ENVS var
/**
 * Decide whether ONE configured credential is usable, WITHOUT mutating the
 * environment. See checkProviderAuth for the all-entries wrapper.
 */
export function checkAuthEntry(
  entry: AuthConfigEntry,
  env: NodeJS.ProcessEnv = process.env,
): AuthReadiness {
  const { mode, provider, tokenEnv, upstream } = entry;

  if (tokenEnv && FORBIDDEN_TOKEN_ENVS.has(tokenEnv)) {
    return {
      ok: false,
      detail:
        `auth.tokenEnv is "${tokenEnv}", a well-known non-provider secret; refusing to ` +
        `forward it to the model provider (that would leak it). Point auth.tokenEnv at a ` +
        `token minted for the provider instead.`,
    };
  }

  // A well-known provider key env may only feed THAT provider. The tokenEnv guard
  // locks which env names are forwarded, but not where they go — without this, a
  // PR-supplied auth entry could keep the locked name (e.g. OPENAI_API_KEY) and
  // point its provider/upstream somewhere else, sending one provider's key to a
  // different provider.
  if (tokenEnv) {
    const keyOwner =
      Object.entries(PROVIDER_KEY_ENV).find(([, env]) => env === tokenEnv)?.[0] ??
      ANTHROPIC_TOKEN_ENVS[tokenEnv];
    if (keyOwner && keyOwner !== provider && keyOwner !== upstream) {
      return {
        ok: false,
        detail:
          `auth for ${provider} names tokenEnv "${tokenEnv}", which is ${keyOwner}'s ` +
          `well-known credential env — refusing to send one provider's credential to another. ` +
          `Use a credential minted for ${provider}${upstream ? ` (upstream ${upstream})` : ""}, ` +
          `or fix the provider/upstream mapping.`,
      };
    }
  }

  // anthropic is ALWAYS served by the Claude Code CLI (engine inferred from the
  // `anthropic/…` model, not from `mode`), so `mode` is irrelevant here. The
  // credential is the machine's `claude` login, an ambient CLAUDE_CODE_OAUTH_TOKEN,
  // or a named tokenEnv. The CLI validates the token, so the only token-shape check
  // here is a coarse exfil guard on a NAMED tokenEnv's value (below); the
  // FORBIDDEN/cross-provider guards above already block the well-known secrets.
  if (provider === "anthropic") {
    // A named-but-unset tokenEnv is NOT fatal: startClaudeCode falls back to the
    // machine's `claude` login (the common local case — the config names the CI
    // secret). startClaudeCode still fails fast when neither credential exists.
    if (tokenEnv && !env[tokenEnv]) {
      return {
        ok: true,
        detail: `anthropic via the Claude Code CLI; falling back to the local \`claude\` login`,
        warning:
          `token env "${tokenEnv}" is not set — using the machine's \`claude\` login ` +
          `(set it for CI/headless runs; mint with \`claude setup-token\`).`,
      };
    }
    // tokenEnv is set AND present: its value is forwarded to api.anthropic.com as the
    // bearer. The destination is ALWAYS Anthropic, so a value that is not an Anthropic
    // credential ("sk-ant-…" covers both the "sk-ant-oat" OAuth token and "sk-ant-api"
    // keys) cannot authenticate there but CAN be a foreign CI secret the config named
    // — refuse it. This meets the "cannot be valid" bar the shape heuristics use, and
    // fires at both prepareAuth and startClaudeCode's forwarding-site recheck.
    if (tokenEnv && env[tokenEnv] && !env[tokenEnv]!.startsWith("sk-ant-")) {
      return {
        ok: false,
        detail:
          `token env "${tokenEnv}" does not hold an Anthropic credential (expected "sk-ant-…", ` +
          `the shape \`claude setup-token\` prints, or an Anthropic API key). anthropic is served ` +
          `by the Claude Code CLI, which authenticates to Anthropic, so a value of another shape ` +
          `cannot work there and would leak that secret to Anthropic — point auth.tokenEnv at a ` +
          `token minted for Anthropic.`,
      };
    }
    return {
      ok: true,
      detail:
        `anthropic via the Claude Code CLI; ` +
        (tokenEnv ? `token env ${tokenEnv} is set` : "using the local `claude` login"),
    };
  }

  if (mode === "oauth") {
    if (!tokenEnv) {
      return {
        ok: false,
        detail: `auth mode "oauth" for ${provider} requires tokenEnv to name the env var holding the OAuth token.`,
      };
    }
    if (!env[tokenEnv]) {
      return {
        ok: false,
        detail: `auth is oauth for ${provider} but token env "${tokenEnv}" is not set.`,
      };
    }
    const shape = checkOauthTokenShape(provider, env[tokenEnv]!, tokenEnv);
    if (!shape.ok) {
      return shape;
    }
    return { ...shape, detail: `oauth for ${provider}; token env ${tokenEnv} is set` };
  }

  // api-key with an upstream alias: the synthesized provider reads the key
  // straight from {env:tokenEnv}, so both must exist — there is no ambient
  // fallback for a provider id we invented.
  if (upstream) {
    if (!tokenEnv) {
      return {
        ok: false,
        detail: `auth for ${provider} (upstream ${upstream}) requires tokenEnv — the synthesized provider reads the key from that env var.`,
      };
    }
    if (!env[tokenEnv]) {
      return {
        ok: false,
        detail: `auth for ${provider} (upstream ${upstream}) names token env "${tokenEnv}" but it is not set.`,
      };
    }
    return {
      ok: true,
      detail: `api-key for ${provider} (upstream ${upstream}); token env ${tokenEnv} is set`,
    };
  }

  // api-key: usable if the configured tokenEnv is set, or the provider's own key
  // env is already present in the environment.
  const providerKeyEnv = PROVIDER_KEY_ENV[provider];
  if (tokenEnv && env[tokenEnv]) {
    return { ok: true, detail: `api-key for ${provider}; token env ${tokenEnv} is set` };
  }
  if (providerKeyEnv && env[providerKeyEnv]) {
    return { ok: true, detail: `api-key for ${provider}; ${providerKeyEnv} is set` };
  }
  if (!tokenEnv && !providerKeyEnv) {
    return {
      ok: true,
      detail: `api-key for ${provider}; no tokenEnv configured and no known key env — relying on OpenCode's own login`,
    };
  }
  const names = [tokenEnv, providerKeyEnv].filter(Boolean).join(" or ");
  return {
    ok: false,
    detail:
      `configured api-key for ${provider} but no credential is set — set ${names}, or set ` +
      `REVIEWER_MODEL to a model you're already logged into.`,
  };
}

/**
 * The set of providers this config actually routes a model to: the `provider/`
 * prefix of every agent model plus the coordinator's. Returns null when no model
 * information is available (e.g. a bare config in a unit test) — callers read that
 * as "can't scope, consider every entry". Every real config loaded by
 * loadReviewConfig has agents, so scoping always applies at runtime.
 *
 * The fixed cross-cutting/verifier roles reuse an agent's model, so their provider
 * is already covered by the agent set — mirrors engineForModel's `provider/` split.
 */
function providersInUse(config: LoadedConfig): Set<string> | null {
  const models: string[] = [];
  for (const agent of config.agents ?? []) {
    if (agent.model) {
      models.push(agent.model);
    }
  }
  if (config.coordinator?.model) {
    models.push(config.coordinator.model);
  }
  if (models.length === 0) {
    return null;
  }
  const providers = new Set<string>();
  for (const model of models) {
    const slash = model.indexOf("/");
    providers.add(slash > 0 ? model.slice(0, slash) : model);
  }
  return providers;
}

/**
 * Decide whether EVERY configured provider credential a model actually uses is
 * usable, WITHOUT mutating the environment. Shared by `prepareAuth` (fail fast
 * before spinning up the server and every pass) and `doctor` (report), so the two
 * never drift.
 *
 * Scoped to providers in use: an `auth` entry for a provider no agent routes to is
 * dead config (the shipped default is `api-key`/openai, so a config that switches
 * every model to `anthropic/…` but leaves — or omits — the `auth` block would
 * otherwise be spuriously blocked demanding OPENAI_API_KEY, defeating the
 * `claude`-login fallback). Only used entries gate the run; all of them must pass —
 * a mixed setup with one broken credential would fail exactly the passes routed to
 * it, which is the silent-degradation this check exists to prevent. `REVIEWER_MODEL`
 * bypasses provider auth entirely.
 */
export function checkProviderAuth(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): AuthReadiness {
  if (env.REVIEWER_MODEL) {
    return {
      ok: true,
      detail: `REVIEWER_MODEL override (${env.REVIEWER_MODEL}); using OpenCode's own login for that model`,
    };
  }

  const inUse = providersInUse(config);
  const details: string[] = [];
  const warnings: string[] = [];
  for (const entry of config.auth) {
    if (inUse && !inUse.has(entry.provider)) {
      continue;
    }
    const readiness = checkAuthEntry(entry, env);
    if (!readiness.ok) {
      return readiness;
    }
    details.push(readiness.detail);
    if (readiness.warning) {
      warnings.push(readiness.warning);
    }
  }
  return {
    ok: true,
    // No used entry (e.g. every model is anthropic and the only `auth` block is the
    // shipped openai default): the run relies on the Claude Code CLI's own login.
    detail:
      details.join("; ") ||
      "no provider credential needed for the models in use (relying on the engine's own login)",
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}

/** A ChatGPT access token is a JWT (three base64url segments); refresh tokens are opaque. */
export function isJwtAccessToken(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}

/** A JWT's `exp` claim as epoch ms, decoded (not verified) — null when unreadable. */
export function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The auth.json entry for one oauth credential. Shaped by what the token IS:
 * - a JWT (an ACCESS token, e.g. from `ecr setup-auth` or a rotator job): use it
 *   as-is and never refresh — refresh tokens are SINGLE-USE (rotation), so a
 *   static/shared secret must not participate in rotation at all. Expiry comes
 *   from the JWT's own `exp` claim so OpenCode trusts it exactly as long as it
 *   is valid.
 * - an opaque openai token (a REFRESH token): store it with `expires: 0` and let
 *   OpenCode's codex plugin mint the access token. Only safe when this run is
 *   the token's SOLE consumer — a value shared across runs/repos dies on first
 *   rotation (learned the hard way).
 * - everything else: the token IS the access credential (e.g. long-lived
 *   setup-token style bearers), far-future expiry so OpenCode never tries to
 *   refresh a credential that has no refresh half.
 */
// @ref LLP 0003#credential-resolution-and-forwarding [implements] — JWT access tokens are used as-is and never refreshed; opaque tokens are stored with expires:0 for the codex refresh flow, only safe when this run is the token's sole consumer (refresh tokens are single-use)
export function oauthAuthJsonEntry(
  provider: string,
  token: string,
): Record<string, string | number> {
  if (provider === "openai" && !isJwtAccessToken(token)) {
    return { type: "oauth", access: "", refresh: token, expires: 0 };
  }
  const expires = isJwtAccessToken(token) ? jwtExpiryMs(token) : null;
  return { type: "oauth", access: token, refresh: "", expires: expires ?? Date.now() + YEAR_MS };
}

/**
 * Prepare model credentials for the OpenCode server from the repo's auth entries
 * (any mix of modes/providers). Must run before the server starts (it mutates
 * env). Returns a cleanup handle.
 *
 * - `api-key` (standard provider): copy the configured token env into the
 *   provider's API-key env var (so the workflow can pass a namespaced secret and
 *   OpenCode still finds it).
 * - `api-key` (upstream alias): nothing to do here — buildOpencodeConfig
 *   synthesizes a provider block whose options read `{env:tokenEnv}` directly.
 * - `oauth`: write ALL oauth credentials into one isolated OpenCode `auth.json`
 *   and point OpenCode at it via XDG_DATA_HOME (see oauthAuthJsonEntry for the
 *   per-provider shapes). Isolated so it never touches the developer's real
 *   auth.json.
 */
// @ref LLP 0003#credential-resolution-and-forwarding [implements] — stages all OAuth credentials into one isolated auth.json under a temp XDG_DATA_HOME; anthropic never passes through this path (its credential goes straight into startClaudeCode's child env)
export async function prepareAuth(config: LoadedConfig): Promise<PreparedAuth> {
  const noop: PreparedAuth = { cleanup: async () => {} };

  // REVIEWER_MODEL is an explicit "use this model with my own creds" override — a
  // common local case (e.g. the repo config targets a CI credential, but a dev
  // runs against their own OpenCode login). Don't inject the configured providers'
  // auth; let OpenCode use whatever it's logged into for the override model.
  if (process.env.REVIEWER_MODEL) {
    return noop;
  }

  // Fail fast, before starting the server and every pass, if ANY configured
  // provider has no usable credential — otherwise it surfaces as N failed passes
  // mid-run. This is the same readiness check `doctor` reports, and it also covers
  // the forbidden-secret guard (refusing to forward a well-known unrelated secret).
  const readiness = checkProviderAuth(config);
  if (!readiness.ok) {
    throw new Error(readiness.detail);
  }

  // Same scoping as checkProviderAuth: only forward credentials for providers a
  // model actually routes to. A dead entry for an unused provider must not have its
  // tokenEnv copied into a key env — checkProviderAuth skipped its guard, so
  // forwarding it here would reintroduce the exact secret-forwarding it prevents.
  const inUse = providersInUse(config);
  const authJson: Record<string, unknown> = {};
  for (const entry of config.auth) {
    const { mode, provider, tokenEnv, upstream } = entry;
    if (inUse && !inUse.has(provider)) {
      continue;
    }
    const value = tokenEnv ? process.env[tokenEnv] : undefined;
    // anthropic is claude-engine-only: it never writes an OpenCode auth.json /
    // XDG_DATA_HOME nor injects ANTHROPIC_API_KEY here — its credential is passed
    // per-invocation via the child env built in startClaudeCode.
    if (provider === "anthropic") {
      continue;
    }
    if (mode === "api-key") {
      // Upstream aliases read {env:tokenEnv} from the synthesized provider block.
      if (!upstream && tokenEnv && value) {
        const target = PROVIDER_KEY_ENV[provider] ?? "ANTHROPIC_API_KEY";
        // The explicitly-configured tokenEnv is authoritative — set it even if the
        // provider env is already present, so config wins over ambient env.
        process.env[target] = value;
      }
      continue;
    }
    // oauth — checkProviderAuth guarantees tokenEnv is set and present; read
    // defensively so TypeScript narrows and this stays correct if called directly.
    if (!value) {
      throw new Error(
        `auth mode "oauth" for ${provider} requires tokenEnv to name a set OAuth token env.`,
      );
    }
    authJson[provider] = oauthAuthJsonEntry(provider, value);
  }

  if (Object.keys(authJson).length === 0) {
    return noop;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "ecr-auth-"));
  await mkdir(path.join(dir, "opencode"), { recursive: true });
  await writeFile(path.join(dir, "opencode", "auth.json"), JSON.stringify(authJson), "utf8");
  process.env.XDG_DATA_HOME = dir;

  return {
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
