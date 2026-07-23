import {
  loadReviewConfig,
  loadScopeConfig,
  loadAuthFromRoot,
  hasConfig,
  resolveConfigDir,
} from "../config/load.js";
import { loadRoutingManifest, resolveScopes, formatOwnerTable } from "../config/routing.js";
import type { LoadedScopeConfig } from "../config/load.js";
import type { RoutingManifest } from "../config/schema.js";
import { checkProviderAuth } from "../core/auth.js";
import { git, onPath, repoRoot, run } from "../core/exec.js";
import { errorMessage } from "../core/util.js";

const USAGE = `ecr doctor — check environment, config, and credentials

Usage:
  ecr doctor [--list-scopes]

Verifies: opencode + git (+ gh for \`ecr ci\`) on PATH, .expo-code-review/ config is
valid, agent prompts resolve, and the configured model's token env is set. When a
routing.jsonc is present, also validates every scope, the auth singleton, scope
ownership over tracked files, and comment-tag uniqueness.

Options:
  --list-scopes   Print the routing scope table (name, dir, paths, agents, tag)
`;

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

  const opencodeInstalled = await onPath("opencode");
  line(
    opencodeInstalled,
    opencodeInstalled
      ? "opencode CLI found on PATH"
      : "opencode CLI NOT on PATH (install `opencode-ai`, or add node_modules/.bin to PATH)",
  );

  line(await onPath("git"), "git found on PATH");

  // `gh` is only needed for `ecr ci` (posting PR comments), so treat it as
  // informational (ℹ) rather than a hard failure for local `ecr review` users.
  if (await onPath("gh")) {
    let authed = false;
    try {
      await run("gh", ["auth", "status"], { cwd: root });
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

  let rootConfig;
  if (!hasConfig(root)) {
    line(false, `no ${".expo-code-review"}/config.jsonc (run \`ecr init\`)`);
  } else {
    try {
      rootConfig = await loadReviewConfig(root);
      line(
        true,
        `config valid: ${rootConfig.agents.length} agent(s) [${rootConfig.agents.map((a) => a.id).join(", ")}], coordinator model ${rootConfig.coordinator.model}`,
      );
      line(
        rootConfig.agents.every((a) => Boolean(a.promptText.trim())),
        "all agent prompt files resolved and non-empty",
      );

      const readiness = checkProviderAuth(rootConfig);
      line(readiness.ok, `auth: ${readiness.detail}`);
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

    // Per-scope comment markers are always derived (`<tag>:<scope>`, unique by
    // scope-name uniqueness) and the scope schema rejects commentTag overrides,
    // so marker collisions are impossible by construction — nothing to check.

    // auth singleton: exactly one honored source (defaults.auth or root config auth).
    const auth = loadAuthFromRoot(rootConfig, manifest);
    const hasManifestAuth = Boolean(manifest.defaults.auth);
    line(
      true,
      `auth singleton: honored from ${hasManifestAuth ? "routing.jsonc defaults.auth" : "root config.jsonc"} (${auth.mode}/${auth.provider})`,
    );
    if (auth.tokenEnv) {
      const expected = process.env.ECR_EXPECTED_TOKEN_ENV;
      if (expected && expected !== auth.tokenEnv) {
        line(false, `auth.tokenEnv "${auth.tokenEnv}" != ECR_EXPECTED_TOKEN_ENV "${expected}"`);
      } else {
        line(
          Boolean(process.env[auth.tokenEnv]),
          `auth token env ${auth.tokenEnv} is ${process.env[auth.tokenEnv] ? "set" : "NOT set"}`,
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
