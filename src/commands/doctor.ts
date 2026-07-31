// @ref LLP 0007#doctor-and-setup-auth — a preflight that must never disagree with a real run
import {
  loadReviewConfig,
  loadScopeConfig,
  loadAuthFromRoot,
  hasConfig,
  resolveConfigDir,
  tokenEnvMismatch,
} from "../config/load.js";
import {
  loadRoutingManifest,
  resolveScopes,
  scopePassesBudgetMs,
  formatOwnerTable,
} from "../config/routing.js";
import readline from "node:readline/promises";

import type { LoadedScopeConfig } from "../config/load.js";
import type { LoadedConfig, RoutingManifest } from "../config/schema.js";
import { setupAuthCommand } from "./setup-auth.js";
import { checkProviderAuth } from "../core/auth.js";
import {
  claudeSubscriptionActive,
  claudeTokenCredential,
  engineForModel,
  resolveClaudeCli,
} from "../core/claude-code.js";
import type { Engine } from "../core/claude-code.js";
import { CLAUDE_CODE_ENGINE, opencodeBinSource } from "../core/opencode.js";
import {
  git,
  onPath,
  pathInside,
  repoRoot,
  resolveOnPath,
  resolveTrustedTool,
  run,
} from "../core/exec.js";
import { errorMessage } from "../core/util.js";
import { tmpdir } from "node:os";
import path from "node:path";

const USAGE = `ecr doctor — check environment, config, and credentials

Usage:
  ecr doctor [--list-scopes]

Verifies: the engines the config's models actually use — opencode on PATH for
non-anthropic models, and for anthropic models the \`claude\` CLI plus a usable
Claude credential (subscription login or token env) — plus git (+ gh for
\`ecr ci\`), that .expo-code-review/ config is valid, agent prompts resolve, and
the configured model's token env is set. When a routing.jsonc is present, also
validates every scope, the auth singleton, scope ownership over tracked files,
and comment-tag uniqueness.

Options:
  --list-scopes   Print the routing scope table (name, dir, paths, agents, tag)
`;

/**
 * `<cliPath> --version`, run from tmpdir() (never the inherited, possibly untrusted
 * cwd). `cliPath` is an already-resolved absolute path — doctor may run inside a cloned
 * untrusted repo, so the binary is resolved-and-checked before it reaches here, never a
 * bare `opencode`. Null when it can't be determined — a version we can't read is worth
 * staying quiet about, not failing over.
 */
async function opencodeVersion(cliPath: string): Promise<string | null> {
  const { stdout, code } = await run(cliPath, ["--version"], { check: false, cwd: tmpdir() });
  if (code !== 0) {
    return null;
  }
  return stdout.trim().split("\n")[0]?.trim() || null;
}

// @ref LLP 0007#doctor-and-setup-auth [implements] — folds routed scopes' models in; silently skips unloadable scope configs by design
/**
 * The engines this repo actually drives, mirroring how real reviews resolve them:
 * engineForModel over every ROOT agent + coordinator model, PLUS every loaded scope
 * config's agents + coordinator. A routed scope can select an anthropic/… model while
 * the root config is OpenCode-only, so without folding scopes in doctor would report
 * success without ever checking the Claude CLI/login the scoped review needs. A scope
 * that fails to load is skipped here — the scope-validation block reports it with the
 * full error. Exported for tests.
 */
export async function resolveEngines(
  root: string,
  rootConfig: LoadedConfig,
  manifest: RoutingManifest | null,
): Promise<Set<Engine>> {
  const engines = new Set<Engine>();
  const add = (config: LoadedConfig): void => {
    for (const agent of config.agents) {
      engines.add(engineForModel(agent.model));
    }
    engines.add(engineForModel(config.coordinator.model));
  };
  add(rootConfig);
  if (manifest) {
    for (const scope of manifest.scopes) {
      try {
        add(await loadScopeConfig(root, scope, manifest, rootConfig));
      } catch {
        // Malformed scope config: reported by the scope-validation block below.
      }
    }
  }
  return engines;
}

/** Preflight checks so a broken setup surfaces clearly instead of silently no-opping. */
export async function doctorCommand(argv: string[] = []): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const root = (await repoRoot()) ?? process.cwd();

  if (argv.includes("--list-scopes")) {
    await listScopes(root);
    return;
  }

  let ok = true;
  const line = (pass: boolean, message: string): void => {
    if (!pass) {
      ok = false;
    }
    process.stdout.write(`  ${pass ? "✓" : "✗"} ${message}\n`);
  };
  const info = (message: string): void => {
    process.stdout.write(`  ℹ ${message}\n`);
  };
  const warn = (message: string): void => {
    process.stdout.write(`  ⚠ ${message}\n`);
  };

  process.stdout.write(`expo-code-review doctor (repo: ${root})\n`);

  // When the ROOT config dir is overridden, config.jsonc AND routing.jsonc are
  // read from the resolved dir (scope subtrees stay repo-root-relative). Surface
  // it so a green doctor run can't hide that it checked a non-default root.
  if (process.env.ECR_CONFIG_DIR) {
    info(
      `ECR_CONFIG_DIR override active: root config.jsonc and routing.jsonc read from ${resolveConfigDir(root)} (scope subtrees stay repo-root-relative)`,
    );
  }

  // Peek at the config to resolve the engine BEFORE the opencode checks: a
  // claude-code-only repo never touches OpenCode, and a missing `opencode` CLI
  // must not fail its doctor run. Load errors are swallowed here — the config
  // block below reports them properly and defaults the engine to OpenCode.
  let rootConfig: Awaited<ReturnType<typeof loadReviewConfig>> | undefined;
  if (hasConfig(root)) {
    try {
      rootConfig = await loadReviewConfig(root);
    } catch {
      // reported by the config block below
    }
  }
  // Engines actually in use by this config: run engineForModel over every agent
  // model + the coordinator model, ACROSS the root config AND every routed scope.
  // Both blocks below may fire in one run (a mixed config drives OpenCode and the
  // Claude Code CLI at once).
  let engines = new Set<Engine>(["opencode"]);
  // Auth as real reviews resolve it (loadScopeConfig/`ecr ci`): a routing.jsonc
  // `defaults.auth` OVERRIDES the root config's auth, so the Claude credential
  // checks below must use the overridden value or a monorepo whose manifest swaps
  // the anthropic entry gets the wrong checks here. (The engine set is model-only.)
  let resolvedAuth = rootConfig?.auth ?? [];
  if (rootConfig) {
    try {
      const manifest = await loadRoutingManifest(root);
      resolvedAuth = loadAuthFromRoot(rootConfig, manifest);
      engines = await resolveEngines(root, rootConfig, manifest);
    } catch {
      // malformed manifest/auth: reported by the blocks below; keep the opencode default
      engines = new Set(["opencode"]);
    }
  }

  // The SDK spawns a bare `opencode`, so the version that actually runs is a PATH
  // lookup. Report which one wins and whether it matches the version this package
  // pins: a stale global install against a newer SDK rejects model ids the SDK
  // considers valid (`ProviderModelNotFoundError`), which is otherwise a baffling
  // failure that only reproduces on one machine. `startOpencode` prepends our own
  // bin dir so the pinned one wins at runtime — this just makes the drift visible.
  if (!engines.has("opencode")) {
    info("OpenCode is not used by this config (claude-code engine) — skipping its checks");
  } else {
    const bin = opencodeBinSource();
    const opencodeInstalled = (await onPath("opencode")) || bin.pinned;
    line(
      opencodeInstalled,
      opencodeInstalled
        ? "opencode CLI available"
        : "opencode CLI NOT found (install `opencode-ai`, or add node_modules/.bin to PATH)",
    );
    if (opencodeInstalled) {
      const pinnedVersion = bin.dir ? await opencodeVersion(path.join(bin.dir, "opencode")) : null;
      // PATH's `opencode`, resolved from a trusted cwd (resolveOnPath) with an in-tree
      // refusal: doctor may run in a cloned untrusted repo, so this drift probe must
      // never execute a bare name against the inherited cwd (a committed shim would win
      // on Windows). onPath above only tests existence — this is the executed one.
      const pathCli = await resolveOnPath("opencode");
      const pathVersion =
        pathCli && !pathInside(pathCli, process.cwd()) ? await opencodeVersion(pathCli) : null;
      if (pinnedVersion) {
        line(true, `opencode ${pinnedVersion} (bundled with this reviewer; used at runtime)`);
        if (pathVersion && pathVersion !== pinnedVersion) {
          warn(
            `a different opencode ${pathVersion} is first on your PATH — runs use the bundled ${pinnedVersion}, ` +
              `but other tooling (and \`opencode\` by hand) will use ${pathVersion}`,
          );
        }
      } else if (pathVersion) {
        warn(
          `using opencode ${pathVersion} from PATH — this reviewer's own \`opencode-ai\` dependency could not be ` +
            `resolved, so the CLI and SDK versions can drift (a stale CLI rejects model ids the SDK accepts)`,
        );
      }
    }
  }

  line(await onPath("git"), "git found on PATH");

  // `gh` is only needed for `ecr ci` (posting PR comments), so treat it as
  // informational (ℹ) rather than a hard failure for local `ecr review` users.
  if (await onPath("gh")) {
    let authed = false;
    try {
      // resolveTrustedTool refuses an in-tree `gh` (throws) — caught here and treated
      // as "found but not authenticated", keeping this probe informational, not fatal.
      const gh = await resolveTrustedTool("gh");
      await run(gh, ["auth", "status"], { cwd: root });
      authed = true;
    } catch {
      authed = false;
    }
    if (authed) {
      line(true, "gh CLI found and authenticated (used by `ecr ci`)");
    } else {
      info("gh CLI found but not authenticated — run `gh auth login` before `ecr ci`");
    }
  } else {
    info("gh CLI not on PATH — only needed for `ecr ci` (posting PR comments)");
  }

  if (!hasConfig(root)) {
    line(false, `no ${".expo-code-review"}/config.jsonc (run \`ecr init\`)`);
  } else {
    try {
      // Reuse the engine-detection peek above; re-load only if that failed so
      // the error surfaces here with full reporting.
      rootConfig ??= await loadReviewConfig(root);
      line(
        true,
        `config valid: ${rootConfig.agents.length} agent(s) [${rootConfig.agents.map((a) => a.id).join(", ")}], coordinator model ${rootConfig.coordinator.model}`,
      );
      line(
        rootConfig.agents.every((a) => Boolean(a.promptText.trim())),
        "all agent prompt files resolved and non-empty",
      );

      // Set when the Claude Code engine has no usable credential. checkProviderAuth
      // (below) returns ok:true for every anthropic shape (login fallback), so this
      // is the only signal that flips the exit code and offers the setup-auth fix.
      let claudeCredentialMissing = false;

      const readiness = checkProviderAuth(rootConfig);
      line(readiness.ok, `auth: ${readiness.detail}`);
      // A suspicious-but-not-provably-broken credential: worth saying, never a failure
      // (the shape rules are heuristics — see checkOauthTokenShape).
      if (readiness.warning) {
        warn(`auth: ${readiness.warning}`);
      }

      // Claude Code engine: the `opencode` block above is not load-bearing for
      // these configs, so check the `claude` CLI + subscription login instead.
      try {
        if (engines.has(CLAUDE_CODE_ENGINE)) {
          // Resolve to a trusted absolute path (and refuse an in-tree binary), never a
          // bare `claude`: doctor may run inside a cloned untrusted repo, so a
          // PR-committed shim must not be the thing we probe. Same resolution the
          // review engine uses.
          const claudeCliPath = await resolveClaudeCli();
          line(
            Boolean(claudeCliPath),
            claudeCliPath
              ? "claude CLI available (Claude Code engine)"
              : "claude CLI NOT found (npm i -g @anthropic-ai/claude-code, then `claude setup-token`)",
          );
          if (claudeCliPath) {
            const version = await run(claudeCliPath, ["--version"], {
              check: false,
              cwd: tmpdir(),
            });
            if (version.code === 0) {
              line(true, `claude ${version.stdout.trim().split("\n")[0]?.trim()}`);
            }
            // @ref LLP 0007#doctor-and-setup-auth [constrained-by] — mirrors startClaudeCode's condition exactly; warn() never flips the exit code
            // Mirror startClaudeCode's credential condition EXACTLY so doctor fails
            // iff a review would: a run needs an active `claude` subscription login OR
            // a token value (the configured tokenEnv, else an ambient
            // CLAUDE_CODE_OAUTH_TOKEN). warn() never flips the exit code, so a missing
            // credential must be a line(false) here, not a ⚠.
            const claudeEntry = resolvedAuth.find((a) => a.provider === "anthropic");
            const hasTokenCredential = Boolean(claudeTokenCredential(claudeEntry));
            const subscriptionActive = await claudeSubscriptionActive({ cliPath: claudeCliPath });
            if (subscriptionActive) {
              info("subscription login: Claude Max/Team account");
            } else if (hasTokenCredential) {
              const src = claudeEntry?.tokenEnv ?? "CLAUDE_CODE_OAUTH_TOKEN";
              info(
                `Claude credential: token env ${src} supplies the OAuth token (no active \`claude\` subscription login)`,
              );
            } else {
              claudeCredentialMissing = true;
              line(
                false,
                "no Claude credential: no active `claude` subscription login and no token env " +
                  "value set — run `ecr setup-auth` (or `claude setup-token`)",
              );
            }
          }
        }
      } catch (error) {
        line(false, `auth engine: ${errorMessage(error)}`);
      }
      // A missing credential has a guided fix — offer it right here when someone is
      // at the terminal, rather than making them find the command in the README.
      if (!readiness.ok || claudeCredentialMissing) {
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          let runIt = false;
          try {
            const answer = (await rl.question("  Run `ecr setup-auth` to fix this now? [Y/n] "))
              .trim()
              .toLowerCase();
            runIt = answer === "" || answer === "y" || answer === "yes";
          } finally {
            rl.close();
          }
          if (runIt) {
            await setupAuthCommand([]);
          }
        } else {
          info("run `ecr setup-auth` for a guided credential setup");
        }
      }
    } catch (error) {
      line(false, `config invalid: ${errorMessage(error)}`);
    }
  }

  // Routing manifest checks (only when a routing.jsonc is present).
  let manifest: RoutingManifest | null = null;
  try {
    manifest = await loadRoutingManifest(root);
  } catch (error) {
    line(false, `routing.jsonc invalid: ${errorMessage(error)}`);
  }
  if (manifest && rootConfig) {
    process.stdout.write("\nRouting manifest:\n");
    line(
      true,
      `manifest valid: ${manifest.scopes.length} scope(s), comment mode "${manifest.comment}"`,
    );

    // enforceAgents must exist in the ROOT roster.
    for (const id of manifest.defaults.enforceAgents) {
      const present = rootConfig.agents.some((agent) => agent.id === id);
      line(
        present,
        present
          ? `enforced agent "${id}" found in the root roster`
          : `enforced agent "${id}" is NOT in the root roster (defaults.enforceAgents)`,
      );
    }

    for (const scope of manifest.scopes) {
      let scopeConfig: LoadedScopeConfig;
      try {
        scopeConfig = await loadScopeConfig(root, scope, manifest, rootConfig);
      } catch (error) {
        // A scope config declaring auth/breakGlass/commentTag surfaces its Zod
        // error HERE, before CI.
        line(false, `scope ${scope.name}: ${errorMessage(error)}`);
        continue;
      }
      line(
        true,
        `scope ${scope.name}: ${scopeConfig.agents.length} agent(s) [${scopeConfig.agents.map((a) => a.id).join(", ")}], config ${scope.config}`,
      );
    }

    // Passes-budget headroom: active scopes run sequentially, so the worst case
    // is every scope active at the per-scope floor. If scopes.length × the floor
    // exceeds the total, runs can outlast the total budget (a ⚠, not a failure —
    // tune budget.* or the job timeout).
    const totalMs = manifest.budget.totalPassesMinutes * 60_000;
    const minMs = manifest.budget.minScopeMinutes * 60_000;
    const { overshoot } = scopePassesBudgetMs(totalMs, minMs, manifest.scopes.length);
    if (overshoot) {
      warn(
        `passes budget: ${manifest.scopes.length} scopes × ${manifest.budget.minScopeMinutes}m floor = ${manifest.scopes.length * manifest.budget.minScopeMinutes}m worst case exceeds budget.totalPassesMinutes (${manifest.budget.totalPassesMinutes}m) — raise the job timeout or trim scopes`,
      );
    } else {
      line(
        true,
        `passes budget: worst case ${manifest.scopes.length} scopes × ${manifest.budget.minScopeMinutes}m floor fits budget.totalPassesMinutes (${manifest.budget.totalPassesMinutes}m)`,
      );
    }

    // Per-scope comment markers are always derived (`<tag>:<scope>`, unique by
    // scope-name uniqueness) and the scope schema rejects commentTag overrides,
    // so marker collisions are impossible by construction — nothing to check.

    // auth singleton: exactly one honored source (defaults.auth or root config auth).
    const auth = loadAuthFromRoot(rootConfig, manifest);
    const hasManifestAuth = Boolean(manifest.defaults.auth);
    line(
      true,
      `auth singleton: honored from ${hasManifestAuth ? "routing.jsonc defaults.auth" : "root config.jsonc"} ` +
        `(${auth.map((entry) => `${entry.mode}/${entry.provider}`).join(", ")})`,
    );
    const expected = process.env.ECR_EXPECTED_TOKEN_ENV;
    if (expected) {
      const mismatch = tokenEnvMismatch(auth, expected);
      if (mismatch) {
        line(false, `auth: ${mismatch}`);
      }
    }
    for (const entry of auth) {
      if (entry.tokenEnv) {
        line(
          Boolean(process.env[entry.tokenEnv]),
          `auth token env ${entry.tokenEnv} (${entry.provider}) is ${process.env[entry.tokenEnv] ? "set" : "NOT set"}`,
        );
      }
    }

    // Owner-table dry run over tracked files (graft 4).
    try {
      const tracked = (await git(["ls-files"], root))
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
      const resolution = resolveScopes(manifest, tracked);
      const hasCatchAll = manifest.scopes.some((scope) => scope.paths.includes("**/*"));
      line(
        resolution.unmatched.length === 0 || hasCatchAll,
        resolution.unmatched.length === 0
          ? `scope coverage: all ${tracked.length} tracked file(s) match a scope`
          : `scope coverage: ${resolution.unmatched.length} file(s) match no scope${hasCatchAll ? " (ok — a **/* catch-all exists)" : " (add a **/* catch-all)"}`,
      );
      if (resolution.overlaps.length > 0) {
        warn(`${resolution.overlaps.length} file(s) match >1 scope (last-match wins):`);
        for (const owner of formatOwnerTable(resolution, 20)) {
          process.stdout.write(`${owner}\n`);
        }
      }
    } catch (error) {
      info(`scope coverage: could not run \`git ls-files\` (${errorMessage(error)})`);
    }
  }

  process.stdout.write(ok ? "\nAll good.\n" : "\nIssues found (see ✗ above).\n");
  process.exitCode = ok ? 0 : 1;
}

/** Print the routing scope table; exit 0/1 on manifest validity alone. */
async function listScopes(root: string): Promise<void> {
  let manifest: RoutingManifest | null;
  try {
    manifest = await loadRoutingManifest(root);
  } catch (error) {
    process.stdout.write(`  ✗ routing.jsonc invalid: ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!manifest) {
    process.stdout.write(
      `No ${".expo-code-review"}/routing.jsonc — run \`ecr init --monorepo\`.\n`,
    );
    process.exitCode = 0;
    return;
  }

  let rootConfig;
  try {
    rootConfig = await loadReviewConfig(root);
  } catch (error) {
    process.stdout.write(`  ✗ root config invalid: ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Routing scopes (comment mode: ${manifest.comment}):\n\n`);
  let ok = true;
  for (const scope of manifest.scopes) {
    process.stdout.write(`  ${scope.name}\n`);
    process.stdout.write(`    config:  ${scope.config}\n`);
    process.stdout.write(`    paths:   ${scope.paths.join(", ")}\n`);
    try {
      const config = await loadScopeConfig(root, scope, manifest, rootConfig);
      process.stdout.write(
        `    agents:  ${config.agents.map((a) => (a.alwaysRun ? `${a.id}*` : a.id)).join(", ")}\n`,
      );
      process.stdout.write(`    tag:     ${config.commentTag}\n`);
    } catch (error) {
      ok = false;
      process.stdout.write(`    ERROR:   ${errorMessage(error)}\n`);
    }
    process.stdout.write("\n");
  }
  process.stdout.write("(* = enforced, alwaysRun)\n");
  process.exitCode = ok ? 0 : 1;
}
