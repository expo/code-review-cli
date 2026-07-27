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
const FORBIDDEN_TOKEN_ENVS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
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
    const keyOwner = Object.entries(PROVIDER_KEY_ENV).find(([, env]) => env === tokenEnv)?.[0];
    if (keyOwner && keyOwner !== provider && keyOwner !== upstream) {
      return {
        ok: false,
        detail:
          `auth for ${provider} names tokenEnv "${tokenEnv}", which is ${keyOwner}'s ` +
          `well-known key env — refusing to send one provider's credential to another. ` +
          `Use a credential minted for ${provider}${upstream ? ` (upstream ${upstream})` : ""}, ` +
          `or fix the provider/upstream mapping.`,
      };
    }
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
 * Decide whether EVERY configured provider credential is usable, WITHOUT
 * mutating the environment. Shared by `prepareAuth` (fail fast before spinning up
 * the server and every pass) and `doctor` (report), so the two never drift.
 *
 * All entries must pass — a mixed setup with one broken credential would fail
 * exactly the passes routed to it, which is the silent-degradation this check
 * exists to prevent. `REVIEWER_MODEL` bypasses provider auth entirely.
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

  const details: string[] = [];
  const warnings: string[] = [];
  for (const entry of config.auth) {
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
    detail: details.join("; "),
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}

/**
 * The auth.json entry for one oauth credential. Provider-shaped:
 * - openai: the durable secret is the REFRESH token (a ChatGPT/Codex sign-in's
 *   access tokens live ~1h, shorter than a worst-case run), so store it with
 *   `expires: 0` and let OpenCode's codex plugin mint access tokens on demand.
 * - everything else: the token IS the access credential (e.g. long-lived
 *   setup-token style bearers), far-future expiry so OpenCode never tries to
 *   refresh a credential that has no refresh half.
 */
export function oauthAuthJsonEntry(
  provider: string,
  token: string,
): Record<string, string | number> {
  if (provider === "openai") {
    return { type: "oauth", access: "", refresh: token, expires: 0 };
  }
  return { type: "oauth", access: token, refresh: "", expires: Date.now() + YEAR_MS };
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

  const authJson: Record<string, unknown> = {};
  for (const entry of config.auth) {
    const { mode, provider, tokenEnv, upstream } = entry;
    const value = tokenEnv ? process.env[tokenEnv] : undefined;
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
