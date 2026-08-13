// @ref LLP 0007#doctor-and-setup-auth — derives a plan from auth config, then guides local credential acquisition
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { hasConfig, loadReviewConfig } from "../config/load.js";
import type { AuthConfigEntry } from "../config/schema.js";
import { jwtExpiryMs } from "../core/auth.js";
import { claudeSubscriptionActive, resolveClaudeCli } from "../core/claude-code.js";
import { resolveOpencodeCli } from "../core/opencode.js";
import { errorMessage } from "../core/util.js";

const USAGE = `ecr setup-auth — set up model credentials for local runs

Reads this repo's .expo-code-review/config.jsonc auth entries and walks through
getting each credential:
  • a ChatGPT/Codex subscription (oauth/openai): runs the bundled
    \`opencode auth login\` (interactive; opens your browser), then prints the
    \`export <tokenEnv>=…\` line to add to your shell config. An existing
    OpenCode ChatGPT sign-in is reused instead of re-authenticating.
  • a Claude Max/Team subscription (any anthropic/… model): reuses an active
    \`claude\` login when present, or runs \`claude setup-token\` (interactive;
    opens your browser) and prints the \`export <tokenEnv>=…\` line for
    CI/headless runs.
  • an API key (api-key entries): prints where to create the key, the exact
    permissions it needs, and the export line to fill in. Meta Model API
    (\`meta/muse-spark-…\`) uses META_API_KEY from the Meta AI developer portal.

Without a repo config, it offers the recommended ChatGPT/Codex subscription flow
with the default env name.

Options:
  --yes   Skip confirmation prompts (still interactive during the login itself).
`;

/** What setup-auth must do for a given auth config. Pure, so it's testable. */
export interface SetupPlan {
  /** oauth/openai entry — satisfiable by an `opencode auth login` ChatGPT sign-in. */
  chatgptLogin?: { tokenEnv: string };
  /** anthropic model/entry — satisfiable by a `claude setup-token` subscription login. */
  claudeLogin?: { tokenEnv: string };
  /** api-key entries — a human must mint these; we print instructions. */
  manualKeys: Array<{ provider: string; tokenEnv: string; upstream?: string }>;
  /** oauth entries for providers we have no automated flow for. */
  unsupported: AuthConfigEntry[];
}

export function planFromAuth(auth: AuthConfigEntry[], models: string[] = []): SetupPlan {
  const plan: SetupPlan = { manualKeys: [], unsupported: [] };
  // anthropic is always served by the Claude Code CLI — a `claude setup-token`
  // subscription login covers it. Trigger on either an explicit anthropic auth
  // entry OR any anthropic/… model in the roster (an entry is entirely optional).
  const anthropicEntry = auth.find((entry) => entry.provider === "anthropic");
  const usesAnthropicModel = models.some(
    (model) => model === "anthropic" || model.startsWith("anthropic/"),
  );
  if (anthropicEntry || usesAnthropicModel) {
    plan.claudeLogin = { tokenEnv: anthropicEntry?.tokenEnv ?? "CLAUDE_CODE_OAUTH_TOKEN" };
  }
  for (const entry of auth) {
    if (entry.provider === "anthropic") {
      continue; // handled above (claude engine); mode is irrelevant here.
    } else if (entry.mode === "oauth" && entry.provider === "openai" && entry.tokenEnv) {
      plan.chatgptLogin = { tokenEnv: entry.tokenEnv };
    } else if (entry.mode === "api-key" && entry.tokenEnv) {
      plan.manualKeys.push({
        provider: entry.provider,
        tokenEnv: entry.tokenEnv,
        upstream: entry.upstream,
      });
    } else if (entry.mode === "oauth") {
      plan.unsupported.push(entry);
    }
    // api-key without tokenEnv relies on OpenCode's own login — nothing to set up.
  }
  return plan;
}

/** Where OpenCode's own (non-isolated) auth.json lives. */
export function opencodeAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

// @ref LLP 0007#doctor-and-setup-auth [constrained-by] — refresh tokens are single-use; they never leave OpenCode's store
/**
 * The stored ChatGPT sign-in's ACCESS token, if OpenCode has a live one. The
 * refresh token deliberately never leaves OpenCode's store: refresh tokens are
 * SINGLE-USE (rotation) and OpenCode is their sole legitimate consumer — a copy
 * in a shell config or CI secret dies on the next rotation and can take the
 * whole sign-in with it. The access token is a plain bearer that stays valid for
 * days and never touches rotation.
 */
async function readStoredAccessToken(): Promise<{ token: string; expiresMs: number } | null> {
  try {
    const raw = await readFile(opencodeAuthJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { type?: string; access?: string } | undefined
    >;
    const openai = parsed.openai;
    if (openai?.type !== "oauth" || !openai.access) {
      return null;
    }
    const expiresMs = jwtExpiryMs(openai.access) ?? 0;
    // An expired stored token means the sign-in needs redoing anyway.
    return expiresMs > Date.now() ? { token: openai.access, expiresMs } : null;
  } catch {
    return null;
  }
}

async function confirm(question: string, skip: boolean): Promise<boolean> {
  if (skip) {
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// @ref LLP 0007#doctor-and-setup-auth [constrained-by] — shell metacharacters in tokens never expand
/** The line to paste into a shell config. Single-quoted: tokens never contain '. */
export function exportLine(tokenEnv: string, value: string): string {
  return `export ${tokenEnv}='${value}'`;
}

export async function setupAuthCommand(argv: string[] = []): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const yes = argv.includes("--yes");
  const out = (line = ""): boolean => process.stdout.write(`${line}\n`);
  const err = (line = ""): boolean => process.stderr.write(`${line}\n`);

  try {
    // Plan from the repo config when there is one; otherwise offer the
    // recommended subscription flow with the default env name.
    let plan: SetupPlan;
    if (hasConfig(process.cwd())) {
      const config = await loadReviewConfig(process.cwd());
      plan = planFromAuth(config.auth, [
        ...config.agents.map((agent) => agent.model),
        config.coordinator.model,
      ]);
    } else {
      err("No .expo-code-review config here — setting up the default ChatGPT/Codex flow.");
      plan = planFromAuth([
        { provider: "openai", mode: "oauth", tokenEnv: "CODEX_OAUTH_ACCESS_TOKEN" },
      ]);
    }

    if (
      !plan.chatgptLogin &&
      !plan.claudeLogin &&
      plan.manualKeys.length === 0 &&
      plan.unsupported.length === 0
    ) {
      out(
        "This repo's auth config needs no local credential setup (OpenCode's own login covers it).",
      );
      return;
    }

    const exports: string[] = [];

    if (plan.claudeLogin) {
      const { tokenEnv } = plan.claudeLogin;
      if (process.env[tokenEnv]) {
        err(`✓ ${tokenEnv} is already set in this shell — skipping the Claude subscription login.`);
      } else {
        // Resolve to a trusted absolute path (refusing an in-tree binary), never a
        // bare `claude`: setup-auth may run inside a cloned untrusted repo, so a
        // PR-committed shim must not be the `claude` we probe or hand the terminal to.
        const claudeCliPath = await resolveClaudeCli();
        // A live local `claude` login already covers interactive runs — only CI or
        // a headless box needs the token in an env var.
        const loggedIn = await claudeSubscriptionActive({ cliPath: claudeCliPath ?? undefined });
        if (loggedIn) {
          err(
            "✓ A Claude Max/Team subscription login is active locally — `ecr review` works now. " +
              `You only need ${tokenEnv} for CI/headless runs.`,
          );
        }
        err("`claude setup-token` mints a 1-year subscription token (opens your browser).");
        if (!(await confirm("Run it now?", yes))) {
          err("Skipped `claude setup-token`.");
        } else if (!claudeCliPath) {
          throw new Error(
            "The `claude` CLI is not installed on this host (npm i -g " +
              "@anthropic-ai/claude-code); nothing was changed.",
          );
        } else {
          const result = spawnSync(claudeCliPath, ["setup-token"], {
            stdio: "inherit",
            cwd: os.tmpdir(),
          });
          if (result.status !== 0) {
            throw new Error(
              `\`claude setup-token\` exited with ${result.status ?? "a signal"}; nothing was changed.`,
            );
          }
          // setup-token prints the token to the terminal and persists it nowhere we
          // can read back, so the user pastes it into the export line themselves.
          err(
            `Copy the token \`claude setup-token\` just printed and paste it in place of the ` +
              `placeholder below.`,
          );
          exports.push(exportLine(tokenEnv, "<paste the token setup-token printed>"));
        }
      }
    }

    if (plan.chatgptLogin) {
      const { tokenEnv } = plan.chatgptLogin;
      if (process.env[tokenEnv]) {
        err(`✓ ${tokenEnv} is already set in this shell — skipping the ChatGPT sign-in.`);
      } else {
        let stored = await readStoredAccessToken();
        if (stored) {
          err(
            `Found a live ChatGPT sign-in in OpenCode (access token valid ` +
              `${Math.max(1, Math.round((stored.expiresMs - Date.now()) / 86_400_000))} more day(s)).`,
          );
          if (!(await confirm(`Use it for ${tokenEnv}?`, yes))) {
            stored = null;
          }
        }
        if (!stored) {
          err("This will run the bundled `opencode auth login` (interactive).");
          err("When it prompts:");
          err("  1. select the provider:  OpenAI");
          err("  2. select the method:    Sign in with ChatGPT  (Codex subscription)");
          err("  3. your browser opens — sign in and authorize.");
          if (!(await confirm("Run it now?", yes))) {
            err("Skipped the ChatGPT sign-in.");
          } else {
            // Resolve to a trusted absolute path (our bundled shim, else PATH with an
            // in-tree refusal), never a bare `opencode`: setup-auth may run inside a
            // cloned untrusted repo, so a PR-committed shim must not be the CLI we hand
            // the terminal to. Run from tmpdir(), never the (possibly untrusted) cwd —
            // the login writes to OpenCode's global auth store, not the working dir.
            const opencodeCli = await resolveOpencodeCli();
            if (!opencodeCli) {
              throw new Error(
                "The `opencode` CLI is not available (install `opencode-ai`, or add " +
                  "node_modules/.bin to PATH); nothing was changed.",
              );
            }
            const result = spawnSync(opencodeCli, ["auth", "login"], {
              stdio: "inherit",
              cwd: os.tmpdir(),
            });
            if (result.status !== 0) {
              throw new Error(
                `\`opencode auth login\` exited with ${result.status ?? "a signal"}; nothing was changed.`,
              );
            }
            stored = await readStoredAccessToken();
            if (!stored) {
              throw new Error(
                "The login finished but no live ChatGPT sign-in was stored — did you select " +
                  'OpenAI → "Sign in with ChatGPT"? Re-run `ecr setup-auth` to try again.',
              );
            }
          }
        }
        if (stored) {
          // The ACCESS token: a plain bearer, valid for days, no rotation involved.
          // (The refresh token stays in OpenCode's store — it is single-use, and
          // copying it anywhere kills it on the next rotation.)
          exports.push(exportLine(tokenEnv, stored.token));
          err(
            `Note: this access token expires in ~${Math.max(1, Math.round((stored.expiresMs - Date.now()) / 86_400_000))} day(s); ` +
              `re-run \`ecr setup-auth\` then to refresh it (your OpenCode sign-in stays valid).`,
          );
        }
      }
    }

    for (const key of plan.manualKeys) {
      if (process.env[key.tokenEnv]) {
        err(`✓ ${key.tokenEnv} is already set in this shell — skipping.`);
        continue;
      }
      const upstream = key.upstream ?? key.provider;
      err("");
      err(`${key.tokenEnv} (${key.provider}) is an API key — create it by hand:`);
      if (upstream === "openai") {
        err("  https://platform.openai.com/api-keys — in a dedicated project (set a");
        err("  monthly budget), as a RESTRICTED key with exactly two permissions, both");
        err("  under Model capabilities: Responses → Request, Chat completions → Request.");
        err("  Everything else (including List models) stays None.");
      } else if (upstream === "anthropic") {
        err("  https://console.anthropic.com/settings/keys — a workspace-scoped key");
        err("  with a spend limit is all the reviewer needs.");
      } else if (upstream === "meta") {
        // @ref LLP 0007#doctor-and-setup-auth [implements] — Meta uses a manual API key
        err("  https://developer.meta.com/ai/ — create a Model API key with access to");
        err("  Muse Spark, then store it as a dedicated review secret.");
      } else {
        err(`  mint a key for the "${upstream}" provider.`);
      }
      exports.push(exportLine(key.tokenEnv, "<paste the key here>"));
    }

    for (const entry of plan.unsupported) {
      err("");
      err(
        `auth for "${entry.provider}" is mode "oauth", which has no automated setup flow here` +
          `. Set ${entry.tokenEnv ?? "its token env"} manually.`,
      );
    }

    if (exports.length > 0) {
      const rc = process.env.SHELL?.includes("zsh") ? "~/.zshrc" : "your shell config";
      err("");
      err(`Add ${exports.length === 1 ? "this line" : "these lines"} to ${rc}:`);
      out("");
      for (const line of exports) {
        out(`    ${line}`);
      }
      out("");
      err(`Then restart your shell (or \`source ${rc}\`) and run \`ecr doctor\` to verify.`);
    } else {
      err("");
      err("Nothing to add — run `ecr doctor` to verify your setup.");
    }
  } catch (error) {
    err(`setup-auth failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
