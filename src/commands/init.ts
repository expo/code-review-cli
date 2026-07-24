import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_DIRNAME } from "../config/load.js";
import { ROUTING_FILENAME } from "../config/routing.js";
import { RoutingScopeSchema, type RoutingScope } from "../config/schema.js";
import { repoRoot } from "../core/exec.js";
import { errorMessage } from "../core/util.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

const USAGE = `ecr init — scaffold .expo-code-review/ in the current repo

Usage:
  ecr init [--no-workflow] [--force]      Scaffold the root config (+ CI workflow)
  ecr init --monorepo [--force]           …and add a routing.jsonc (one default scope)
  ecr init --scope <dir> [--force]        Scaffold a per-team scope under <dir> and
                                          register it in the root routing.jsonc

Options:
  --monorepo      Also write .expo-code-review/routing.jsonc (routing manifest)
  --scope <dir>   Scaffold <dir>/.expo-code-review/ (no auth) + add a scope entry
  --no-workflow   Skip writing the CI workflow (.github/workflows/expo-code-review.yml)
  --force         Overwrite existing files
  -h, --help      Show this help
`;

export async function initCommand(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    const scopeDir = parseValue(argv, "--scope");
    if (scopeDir != null) {
      await scaffoldScope(argv, scopeDir);
    } else {
      await scaffold(argv);
    }
  } catch (error) {
    process.stderr.write(`init failed: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

/** Scaffold .expo-code-review/ (and optionally the CI workflow + routing manifest). */
async function scaffold(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  // The CI workflow is scaffolded by default (most repos adopting this want it);
  // `--no-workflow` opts out. `--with-workflow` is still accepted as a no-op for
  // back-compat.
  const withWorkflow = !argv.includes("--no-workflow");
  const monorepo = argv.includes("--monorepo");

  const root = (await repoRoot()) ?? process.cwd();
  const configDir = path.join(root, CONFIG_DIRNAME);
  // Create only the config dir; let copyInto create prompts/ so it reports
  // accurately as created vs skipped.
  await mkdir(configDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  await copyInto(
    path.join(TEMPLATES_DIR, "config.jsonc"),
    path.join(configDir, "config.jsonc"),
    force,
    created,
    skipped,
    root,
  );
  await copyInto(
    path.join(TEMPLATES_DIR, "shared.md"),
    path.join(configDir, "shared.md"),
    force,
    created,
    skipped,
    root,
  );
  await copyInto(
    path.join(TEMPLATES_DIR, "coordinator.md"),
    path.join(configDir, "coordinator.md"),
    force,
    created,
    skipped,
    root,
  );
  await copyInto(
    path.join(TEMPLATES_DIR, "agents"),
    path.join(configDir, "agents"),
    force,
    created,
    skipped,
    root,
  );

  const gitignorePath = path.join(configDir, ".gitignore");
  if (force || !existsSync(gitignorePath)) {
    await writeFile(gitignorePath, ".runs/\n", "utf8");
    created.push(path.relative(root, gitignorePath));
  } else {
    skipped.push(path.relative(root, gitignorePath));
  }

  if (monorepo) {
    await copyInto(
      path.join(TEMPLATES_DIR, ROUTING_FILENAME),
      path.join(configDir, ROUTING_FILENAME),
      force,
      created,
      skipped,
      root,
    );
  }

  if (withWorkflow) {
    const workflowDir = path.join(root, ".github", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await copyInto(
      path.join(TEMPLATES_DIR, "workflow.yml"),
      path.join(workflowDir, "expo-code-review.yml"),
      force,
      created,
      skipped,
      root,
    );
  }

  reportFiles(created, skipped);
  process.stdout.write(
    [
      "",
      "Next steps:",
      `  1. Customize ${CONFIG_DIRNAME}/agents/*.md (and shared.md, coordinator.md) for this repo.`,
      "  2. Configure a model provider in OpenCode (or set REVIEWER_MODEL).",
      "  3. Run `ecr doctor`, then `ecr review`.",
      withWorkflow
        ? "  4. Add the model-key secret referenced by the workflow, then add an `ai-review` label to a PR."
        : "  4. (No CI workflow written — re-run without `--no-workflow` to add it.)",
      monorepo
        ? `  5. Add per-team scopes with \`ecr init --scope <dir>\` (see ${CONFIG_DIRNAME}/${ROUTING_FILENAME}).`
        : `  5. Monorepo? Run \`ecr init --monorepo\` to add a routing manifest.`,
      "",
    ].join("\n"),
  );
}

/**
 * Scaffold a per-team scope under <dir>: <dir>/.expo-code-review/ with a no-auth
 * config, prompts and agents, then register the scope in the root routing.jsonc.
 */
async function scaffoldScope(argv: string[], scopeDirRaw: string): Promise<void> {
  const force = argv.includes("--force");
  const root = (await repoRoot()) ?? process.cwd();
  const scopeDir = scopeDirRaw.replace(/\/+$/, "");

  const routingPath = path.join(root, CONFIG_DIRNAME, ROUTING_FILENAME);
  if (!existsSync(routingPath)) {
    throw new Error(`no ${CONFIG_DIRNAME}/${ROUTING_FILENAME} — run \`ecr init --monorepo\` first`);
  }

  // Derive the scope entry and validate it BEFORE creating any files: the name must
  // satisfy RoutingScopeSchema's kebab-case rule (derived by sanitizing the dir,
  // apps/Foo_Bar -> apps-foo-bar), and the config path is rejected when absolute or
  // containing ".." — validating first keeps a traversal dir (e.g. `--scope
  // ../../outside`) from orphaning files outside the repo, and a bad name from
  // making routing.jsonc unloadable and silently stopping every review.
  const entry: RoutingScope = {
    name: scopeDir
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
    paths: [`${scopeDir}/**`],
    config: scopeDir,
  };
  const parsed = RoutingScopeSchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(
      `scope dir "${scopeDir}" yields an invalid scope entry (${parsed.error.issues[0]?.message}); ` +
        `rename the directory or add the scope to ${CONFIG_DIRNAME}/${ROUTING_FILENAME} manually`,
    );
  }

  const configDir = path.join(root, scopeDir, CONFIG_DIRNAME);
  await mkdir(configDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  // The scope's config.jsonc is the auth-free scope template.
  await copyInto(
    path.join(TEMPLATES_DIR, "scope-config.jsonc"),
    path.join(configDir, "config.jsonc"),
    force,
    created,
    skipped,
    root,
  );
  await copyInto(
    path.join(TEMPLATES_DIR, "shared.md"),
    path.join(configDir, "shared.md"),
    force,
    created,
    skipped,
    root,
  );
  await copyInto(
    path.join(TEMPLATES_DIR, "coordinator.md"),
    path.join(configDir, "coordinator.md"),
    force,
    created,
    skipped,
    root,
  );
  await copyInto(
    path.join(TEMPLATES_DIR, "agents"),
    path.join(configDir, "agents"),
    force,
    created,
    skipped,
    root,
  );

  const gitignorePath = path.join(configDir, ".gitignore");
  if (force || !existsSync(gitignorePath)) {
    await writeFile(gitignorePath, ".runs/\n", "utf8");
    created.push(path.relative(root, gitignorePath));
  } else {
    skipped.push(path.relative(root, gitignorePath));
  }

  // Register the scope in the root routing manifest, preserving comments/formatting.
  const raw = await readFile(routingPath, "utf8");
  const updated = appendScopeEntry(raw, entry);
  let manifestNote: string;
  if (updated == null) {
    manifestNote = `  ! could not locate the "scopes" array in ${CONFIG_DIRNAME}/${ROUTING_FILENAME}; add this entry manually:\n      ${JSON.stringify(entry)}`;
  } else if (updated === raw) {
    manifestNote = `  skipped  ${CONFIG_DIRNAME}/${ROUTING_FILENAME} (scope "${entry.name}" already present)`;
  } else {
    await writeFile(routingPath, updated, "utf8");
    manifestNote = `  updated  ${CONFIG_DIRNAME}/${ROUTING_FILENAME} (+ scope "${entry.name}")`;
  }

  reportFiles(created, skipped);
  process.stdout.write(`${manifestNote}\n`);
  process.stdout.write(
    [
      "",
      "Next steps:",
      `  1. Customize ${scopeDir}/${CONFIG_DIRNAME}/agents/*.md for this team.`,
      `  2. Add to CODEOWNERS so only the team edits its scope:`,
      `       /${scopeDir}/${CONFIG_DIRNAME}/ @your-team`,
      "  3. Run `ecr doctor` to verify the config.",
      "",
    ].join("\n"),
  );
}

/**
 * Insert a scope entry before the closing ] of the "scopes" array in raw JSONC,
 * preserving comments/formatting. Returns the new text, the original text unchanged
 * when a scope of the same name is already present, or null when the array can't be
 * located (caller then prints the entry for manual addition).
 */
export function appendScopeEntry(routingRaw: string, entry: RoutingScope): string | null {
  const keyMatch = routingRaw.search(/"scopes"\s*:/);
  if (keyMatch === -1) {
    return null;
  }
  const arrayStart = routingRaw.indexOf("[", keyMatch);
  if (arrayStart === -1) {
    return null;
  }
  // Find the matching close bracket by depth, skipping strings and // and /* */
  // comments, and remember the last CONTENT character inside the array — users
  // annotate routing.jsonc with comments, so the separating comma must land
  // after the last entry, never inside a trailing comment.
  let depth = 0;
  let end = -1;
  let lastContent = -1;
  let i = arrayStart;
  while (i < routingRaw.length) {
    const char = routingRaw[i]!;
    if (char === "/" && routingRaw[i + 1] === "/") {
      const newline = routingRaw.indexOf("\n", i);
      if (newline === -1) {
        break;
      }
      i = newline;
      continue;
    }
    if (char === "/" && routingRaw[i + 1] === "*") {
      const close = routingRaw.indexOf("*/", i + 2);
      if (close === -1) {
        break;
      }
      i = close + 2;
      continue;
    }
    if (char === '"') {
      i++;
      while (i < routingRaw.length && routingRaw[i] !== '"') {
        if (routingRaw[i] === "\\") {
          i++;
        }
        i++;
      }
      lastContent = i;
      i++;
      continue;
    }
    if (char === "[") {
      depth++;
      if (i > arrayStart) {
        lastContent = i;
      }
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
      lastContent = i;
    } else if (!/\s/.test(char)) {
      lastContent = i;
    }
    i++;
  }
  if (end === -1) {
    return null;
  }

  // Idempotent: don't add a duplicate name.
  const inner = routingRaw.slice(arrayStart + 1, end);
  if (new RegExp(`"name"\\s*:\\s*"${escapeRegExp(entry.name)}"`).test(inner)) {
    return routingRaw;
  }

  const line = `    { "name": ${JSON.stringify(entry.name)}, "paths": ${JSON.stringify(entry.paths)}, "config": ${JSON.stringify(entry.config)} }`;
  const hasEntries = lastContent > arrayStart;
  const needsComma = hasEntries && routingRaw[lastContent] !== ",";
  // Insert the comma immediately after the last entry's final character (before
  // any trailing comment), then append the new entry line before the ']'.
  const withComma = needsComma
    ? `${routingRaw.slice(0, lastContent + 1)},${routingRaw.slice(lastContent + 1)}`
    : routingRaw;
  const endAdjusted = needsComma ? end + 1 : end;
  const before = withComma.slice(0, endAdjusted).replace(/\s*$/, "");
  const after = withComma.slice(endAdjusted);
  return `${before}\n${line}\n  ${after}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportFiles(created: string[], skipped: string[]): void {
  for (const file of created) {
    process.stdout.write(`  created  ${file}\n`);
  }
  for (const file of skipped) {
    process.stdout.write(`  skipped  ${file} (exists; use --force to overwrite)\n`);
  }
}

/** Parse a `--flag <value>` option; returns undefined when the flag is absent. */
function parseValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function copyInto(
  src: string,
  dest: string,
  force: boolean,
  created: string[],
  skipped: string[],
  root: string,
): Promise<void> {
  const existed = existsSync(dest);
  await cp(src, dest, { recursive: true, force, errorOnExist: false });
  (existed && !force ? skipped : created).push(path.relative(root, dest));
}
