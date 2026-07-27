import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { hasConfig, loadReviewConfig } from "../config/load.js";
import type { AuthConfigEntry } from "../config/schema.js";
import { opencodeBinSource } from "../core/opencode.js";
import { errorMessage } from "../core/util.js";

const USAGE = `ecr setup-auth — set up model credentials for local runs

Reads this repo's .expo-code-review/config.jsonc auth entries and walks through
getting each credential:
  • a ChatGPT/Codex subscription (oauth/openai): runs the bundled
    \`opencode auth login\` (interactive; opens your browser), then prints the
    \`export <tokenEnv>=…\` line to add to your shell config. An existing
    OpenCode ChatGPT sign-in is reused instead of re-authenticating.
  • an API key (api-key entries): prints where to create the key, the exact
    permissions it needs, and the export line to fill in.

Without a repo config, it offers the recommended ChatGPT/Codex subscription flow
with the default env name.

Options:
  --yes   Skip confirmation prompts (still interactive during the login itself).
`;

/** What setup-auth must do for a given auth config. Pure, so it's testable. */
export interface SetupPlan {
  /** oauth/openai entry — satisfiable by an `opencode auth login` ChatGPT sign-in. */
  chatgptLogin?: { tokenEnv: string };
  /** api-key entries — a human must mint these; we print instructions. */
  manualKeys: Array<{ provider: string; tokenEnv: string; upstream?: string }>;
  /** oauth entries for providers we have no automated flow for. */
  unsupported: AuthConfigEntry[];
}

export function planFromAuth(auth: AuthConfigEntry[]): SetupPlan {
  const plan: SetupPlan = { manualKeys: [], unsupported: [] };
  for (const entry of auth) {
    if (entry.mode === "oauth" && entry.provider === "openai" && entry.tokenEnv) {
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

/** The stored ChatGPT sign-in's refresh token, if OpenCode has one. */
async function readStoredRefreshToken(): Promise<string | null> {
  try {
    const raw = await readFile(opencodeAuthJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { type?: string; refresh?: string } | undefined
    >;
    const openai = parsed.openai;
    return openai?.type === "oauth" && openai.refresh ? openai.refresh : null;
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
      plan = planFromAuth(config.auth);
    } else {
      err("No .expo-code-review config here — setting up the default ChatGPT/Codex flow.");
      plan = planFromAuth([
        { provider: "openai", mode: "oauth", tokenEnv: "CODEX_OAUTH_REFRESH_TOKEN" },
      ]);
    }

    if (!plan.chatgptLogin && plan.manualKeys.length === 0 && plan.unsupported.length === 0) {
      out(
        "This repo's auth config needs no local credential setup (OpenCode's own login covers it).",
      );
      return;
    }

    const exports: string[] = [];

    if (plan.chatgptLogin) {
      const { tokenEnv } = plan.chatgptLogin;
      if (process.env[tokenEnv]) {
        err(`✓ ${tokenEnv} is already set in this shell — skipping the ChatGPT sign-in.`);
      } else {
        let refresh = await readStoredRefreshToken();
        if (refresh) {
          err("Found an existing ChatGPT sign-in in OpenCode.");
          if (!(await confirm(`Reuse it for ${tokenEnv}?`, yes))) {
            refresh = null;
          }
        }
        if (!refresh) {
          err("This will run the bundled `opencode auth login` (interactive).");
          err("When it prompts:");
          err("  1. select the provider:  OpenAI");
          err("  2. select the method:    Sign in with ChatGPT  (Codex subscription)");
          err("  3. your browser opens — sign in and authorize.");
          if (!(await confirm("Run it now?", yes))) {
            err("Skipped the ChatGPT sign-in.");
          } else {
            const binDir = opencodeBinSource().dir;
            const opencode = binDir ? path.join(binDir, "opencode") : "opencode";
            const result = spawnSync(opencode, ["auth", "login"], { stdio: "inherit" });
            if (result.status !== 0) {
              throw new Error(
                `\`opencode auth login\` exited with ${result.status ?? "a signal"}; nothing was changed.`,
              );
            }
            refresh = await readStoredRefreshToken();
            if (!refresh) {
              throw new Error(
                "The login finished but no ChatGPT sign-in was stored — did you select " +
                  'OpenAI → "Sign in with ChatGPT"? Re-run `ecr setup-auth` to try again.',
              );
            }
          }
        }
        if (refresh) {
          // The REFRESH token is the durable secret: access tokens are short-lived,
          // and OpenCode mints them from this on demand.
          exports.push(exportLine(tokenEnv, refresh));
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
      } else {
        err(`  mint a key for the "${upstream}" provider.`);
      }
      exports.push(exportLine(key.tokenEnv, "<paste the key here>"));
    }

    for (const entry of plan.unsupported) {
      err("");
      err(
        `auth for "${entry.provider}" is mode "oauth", which has no automated setup flow here` +
          (entry.provider === "anthropic"
            ? " — and cannot work: Anthropic prohibits subscription tokens in third-party tools. Use an API key instead."
            : `. Set ${entry.tokenEnv ?? "its token env"} manually.`),
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
