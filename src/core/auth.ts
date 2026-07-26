import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoadedConfig } from "../config/schema.js";

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
 * Decide whether the configured model provider has a usable credential, WITHOUT
 * mutating the environment. Shared by `prepareAuth` (fail fast before spinning up
 * the server and every pass) and `doctor` (report), so the two never drift.
 *
 * We only report `ok: false` when we're confident there is no credential — a
 * missing OAuth token, a forbidden tokenEnv, or an api-key run with neither the
 * configured tokenEnv nor the provider's own key env set. When nothing is
 * configured and no known key env is present, we assume OpenCode's own login may
 * cover it and don't hard-fail. `REVIEWER_MODEL` bypasses provider auth entirely.
 */
export function checkProviderAuth(
  config: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): AuthReadiness {
  const { mode, provider, tokenEnv } = config.auth;

  if (env.REVIEWER_MODEL) {
    return {
      ok: true,
      detail: `REVIEWER_MODEL override (${env.REVIEWER_MODEL}); using OpenCode's own login for that model`,
    };
  }

  if (tokenEnv && FORBIDDEN_TOKEN_ENVS.has(tokenEnv)) {
    return {
      ok: false,
      detail:
        `auth.tokenEnv is "${tokenEnv}", a well-known non-provider secret; refusing to ` +
        `forward it to the model provider (that would leak it). Point auth.tokenEnv at a ` +
        `token minted for the provider instead.`,
    };
  }

  if (mode === "oauth") {
    if (!tokenEnv) {
      return {
        ok: false,
        detail:
          'auth.mode "oauth" requires auth.tokenEnv to name the env var holding the OAuth token.',
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
    return { ok: true, detail: `oauth for ${provider}; token env ${tokenEnv} is set` };
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
 * Prepare model credentials for the OpenCode server based on the repo's auth mode.
 * Must run before the server starts (it mutates env). Returns a cleanup handle.
 *
 * - `api-key`: copy the configured token env into the provider's API-key env var
 *   (so the workflow can pass a namespaced secret and OpenCode still finds it).
 * - `oauth`: write an isolated OpenCode `auth.json` with the token as a Bearer
 *   OAuth credential and point OpenCode at it via XDG_DATA_HOME, so it uses its
 *   native Claude Pro/Max path (correct bearer + oauth headers) rather than
 *   x-api-key. Isolated so it never touches the developer's real auth.json.
 */
export async function prepareAuth(config: LoadedConfig): Promise<PreparedAuth> {
  const noop: PreparedAuth = { cleanup: async () => {} };
  const { mode, provider, tokenEnv } = config.auth;

  // REVIEWER_MODEL is an explicit "use this model with my own creds" override — a
  // common local case (e.g. the repo config targets Claude OAuth in CI, but a dev
  // runs against their own OpenAI login). Don't inject the configured provider's
  // auth; let OpenCode use whatever it's logged into for the override model.
  if (process.env.REVIEWER_MODEL) {
    return noop;
  }

  // Fail fast, before starting the server and every pass, if the configured
  // provider has no usable credential — otherwise it surfaces as N failed passes
  // mid-run. This is the same readiness check `doctor` reports, and it also covers
  // the forbidden-secret guard (refusing to forward a well-known unrelated secret).
  const readiness = checkProviderAuth(config);
  if (!readiness.ok) {
    throw new Error(readiness.detail);
  }

  if (mode === "api-key") {
    if (tokenEnv) {
      const value = process.env[tokenEnv];
      const target = PROVIDER_KEY_ENV[provider] ?? "ANTHROPIC_API_KEY";
      // The explicitly-configured tokenEnv is authoritative — set it even if the
      // provider env is already present, so config wins over ambient env.
      if (value) {
        process.env[target] = value;
      }
    }
    return noop;
  }

  // oauth — checkProviderAuth guarantees tokenEnv is set and present; read
  // defensively so TypeScript narrows and this stays correct if called directly.
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (!token) {
    throw new Error('auth.mode "oauth" requires auth.tokenEnv to name a set OAuth token env.');
  }

  const dir = await mkdtemp(path.join(tmpdir(), "ecr-auth-"));
  await mkdir(path.join(dir, "opencode"), { recursive: true });
  const authJson = {
    [provider]: {
      type: "oauth",
      access: token,
      refresh: "",
      // Far-future expiry so OpenCode uses the token as-is and does not try to
      // refresh it (setup-token tokens are long-lived and carry no refresh).
      expires: Date.now() + YEAR_MS,
    },
  };
  await writeFile(path.join(dir, "opencode", "auth.json"), JSON.stringify(authJson), "utf8");
  process.env.XDG_DATA_HOME = dir;

  return {
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
