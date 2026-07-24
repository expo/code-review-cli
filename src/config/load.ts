import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { ReviewConfigSchema, ScopeReviewConfigSchema } from "./schema.js";
import type {
  LoadedAgent,
  LoadedConfig,
  RawReviewConfig,
  RoutingManifest,
  RoutingScope,
} from "./schema.js";
import { toolMap } from "../core/tools.js";

export const CONFIG_DIRNAME = ".expo-code-review";

/** Default OpenCode tool toggles for a reviewer: read the repo, never mutate it. */
const DEFAULT_AGENT_TOOLS = toolMap(["read", "grep", "glob", "list"]);

export function configDirFor(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_DIRNAME);
}

/**
 * Resolve the config directory: an explicit override (absolute or repo-relative)
 * → the ECR_CONFIG_DIR env var → the repo's default `.expo-code-review/`. This is
 * the escape hatch (graft 1); with neither override present the result is exactly
 * `configDirFor(repoRoot)`, so the default behavior is byte-identical.
 */
export function resolveConfigDir(repoRoot: string, override?: string): string {
  const chosen = override ?? process.env.ECR_CONFIG_DIR;
  if (chosen) {
    return path.isAbsolute(chosen) ? chosen : path.join(repoRoot, chosen);
  }
  return path.join(repoRoot, CONFIG_DIRNAME);
}

export interface LoadConfigOptions {
  /** Explicit config dir (absolute or repo-relative). Overrides ECR_CONFIG_DIR. */
  configDir?: string;
}

/** Parsed config with the centrally-locked keys optional (scope configs omit them). */
type ParsedConfig = Omit<RawReviewConfig, "auth" | "breakGlass" | "commentTag"> & {
  auth?: RawReviewConfig["auth"];
  breakGlass?: RawReviewConfig["breakGlass"];
  commentTag?: RawReviewConfig["commentTag"];
};

export function hasConfig(repoRoot: string, options: LoadConfigOptions = {}): boolean {
  // Resolve the same way loadReviewConfig does (incl. the ECR_CONFIG_DIR escape
  // hatch) so doctor's "no config" diagnostic never disagrees with the loader.
  const dir = resolveConfigDir(repoRoot, options.configDir);
  return existsSync(path.join(dir, "config.jsonc")) || existsSync(path.join(dir, "config.json"));
}

/**
 * Discover and fully resolve a repo's review config from `.expo-code-review/`:
 * parse config.jsonc, read every prompt file, and resolve models (with an
 * optional REVIEWER_MODEL env override applied to all agents + the coordinator).
 */
export async function loadReviewConfig(
  repoRoot: string,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const dir = resolveConfigDir(repoRoot, options.configDir);
  return (await loadConfigDir(dir, ReviewConfigSchema)).config;
}

/**
 * The shared per-directory loader: parse config.jsonc, read every prompt file,
 * resolve models. Root and scope loading share this one code path — the schema
 * argument controls whether the centrally-locked keys (auth/breakGlass) are
 * accepted (root) or rejected at the Zod level (scope). `loadReviewConfig` with
 * `ReviewConfigSchema` produces identical output for identical input.
 */
async function loadConfigDir(
  dir: string,
  schema: typeof ReviewConfigSchema | typeof ScopeReviewConfigSchema,
): Promise<{ config: LoadedConfig; raw: Record<string, unknown> }> {
  const configPath = ["config.jsonc", "config.json"]
    .map((name) => path.join(dir, name))
    .find((candidate) => existsSync(candidate));

  if (!configPath) {
    throw new Error(
      `No ${CONFIG_DIRNAME}/config.jsonc found in ${path.dirname(dir)}. Run \`ecr init\` to scaffold one.`,
    );
  }

  const raw = await readFile(configPath, "utf8");
  const rawObject = JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as Record<
    string,
    unknown
  >;
  const parsed = schema.parse(rawObject) as ParsedConfig;

  const override = process.env.REVIEWER_MODEL;
  const defaultModel = override ?? parsed.model;
  const resolveModel = (frontmatterModel?: string): string =>
    override ?? frontmatterModel ?? defaultModel;
  const resolveTemp = (value: string | undefined, fallback: number): number => {
    const n = value == null ? NaN : Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  // shared.md is optional; the coordinator is required.
  const sharedPath = path.join(dir, "shared.md");
  const sharedPromptText = existsSync(sharedPath)
    ? parseFrontmatter(await readFile(sharedPath, "utf8")).body
    : "";

  const coordinatorPath = path.join(dir, "coordinator.md");
  if (!existsSync(coordinatorPath)) {
    throw new Error(`Missing ${CONFIG_DIRNAME}/coordinator.md`);
  }
  const coordinatorMd = parseFrontmatter(await readFile(coordinatorPath, "utf8"));

  // Every markdown file in agents/ is a reviewer agent (id = filename).
  const agentsDir = path.join(dir, "agents");
  if (!existsSync(agentsDir)) {
    throw new Error(`Missing ${CONFIG_DIRNAME}/agents/ directory. Run \`ecr init\`.`);
  }
  const agentFiles = (await readdir(agentsDir)).filter((name) => name.endsWith(".md")).sort();
  if (agentFiles.length === 0) {
    throw new Error(`No agent markdown files in ${CONFIG_DIRNAME}/agents/.`);
  }

  const agents: LoadedAgent[] = [];
  for (const file of agentFiles) {
    const md = parseFrontmatter(await readFile(path.join(agentsDir, file), "utf8"));
    const id = file.replace(/\.md$/, "");
    agents.push({
      id,
      description: md.data.description ?? "",
      alwaysRun: /^(true|yes|1)$/i.test(md.data.alwaysRun ?? ""),
      model: resolveModel(md.data.model),
      temperature: resolveTemp(md.data.temperature, 0.1),
      tools: DEFAULT_AGENT_TOOLS,
      promptText: md.body,
    });
  }

  const config: LoadedConfig = {
    configDir: dir,
    sharedPromptText,
    agents,
    coordinator: {
      model: resolveModel(coordinatorMd.data.model),
      temperature: resolveTemp(coordinatorMd.data.temperature, 0),
      promptText: coordinatorMd.body,
    },
    policy: parsed.policy,
    chunk: parsed.chunk,
    noise: parsed.noise,
    // parsed.breakGlass/auth are always present for the root schema (defaults) and
    // absent for the scope schema; loadScopeConfig overrides both afterwards.
    breakGlassMarker: parsed.breakGlass?.marker ?? "/skip-review",
    // Scope configs can't declare commentTag (scope schema rejects it);
    // loadScopeConfig overwrites this placeholder with the manifest default.
    commentTag: parsed.commentTag ?? "expo-ai-code-reviewer",
    auth: {
      mode: parsed.auth?.mode ?? "api-key",
      provider: parsed.auth?.provider ?? "anthropic",
      tokenEnv: parsed.auth?.tokenEnv,
    },
    review: parsed.review,
  };
  return { config, raw: rawObject };
}

/**
 * auth is honored ONLY here: the manifest's `defaults.auth` wins when present,
 * otherwise the root config.jsonc auth. A scope config can never contribute auth
 * (the scope schema rejects it), so the secret-forwarding surface stays a single,
 * root-owned value no matter how many scopes exist.
 */
export function loadAuthFromRoot(
  rootConfig: LoadedConfig,
  manifest: RoutingManifest | null,
): LoadedConfig["auth"] {
  const override = manifest?.defaults.auth;
  if (override) {
    return { mode: override.mode, provider: override.provider, tokenEnv: override.tokenEnv };
  }
  return rootConfig.auth;
}

export interface LoadedScopeConfig extends LoadedConfig {
  scopeName: string;
}

/**
 * Load one scope's fully-resolved config. The default scope (config '.') reuses
 * the root config unchanged except auth; a nested scope reads its own
 * `.expo-code-review/` via the scope schema (auth/breakGlass rejected by Zod).
 * auth and breakGlass always come from the root; `defaults.enforceAgents` are
 * injected with alwaysRun and win any same-id agent in the scope roster (risk 11).
 */
export async function loadScopeConfig(
  root: string,
  scope: RoutingScope,
  manifest: RoutingManifest,
  rootConfig: LoadedConfig,
): Promise<LoadedScopeConfig> {
  let base: LoadedConfig;
  let commentTag: string;
  if (scope.config === ".") {
    base = rootConfig;
    // The default scope keeps the ROOT comment marker so the existing single
    // comment (and its dismissal state) upserts in place, not duplicated (risk 8).
    commentTag = rootConfig.commentTag;
  } else {
    // Defense in depth behind the schema's traversal refinement: never read a
    // scope config from outside the repo checkout (scope.config is PR-controllable).
    const resolvedRoot = path.resolve(root);
    const resolvedScope = path.resolve(root, scope.config);
    if (resolvedScope !== resolvedRoot && !resolvedScope.startsWith(resolvedRoot + path.sep)) {
      throw new Error(
        `scope "${scope.name}": config "${scope.config}" resolves outside the repo checkout`,
      );
    }
    const dir = path.join(root, scope.config, CONFIG_DIRNAME);
    const { config } = await loadConfigDir(dir, ScopeReviewConfigSchema);
    base = config;
    // Non-default scopes never carry their own marker (the scope schema rejects
    // commentTag): ci derives `<rootTag>:<scope>` for per-scope comments, so the
    // loaded value here is only the manifest default, for display/doctor.
    commentTag = manifest.defaults.commentTag;
  }

  // Inject the enforced agents from the ROOT roster with alwaysRun, replacing any
  // same-id agent the scope defines (the enforced one wins — risk 11).
  const agents: LoadedAgent[] = base.agents.map((agent) => ({ ...agent }));
  for (const id of manifest.defaults.enforceAgents) {
    const rootAgent = rootConfig.agents.find((agent) => agent.id === id);
    if (!rootAgent) {
      throw new Error(
        `defaults.enforceAgents lists "${id}", but the root roster has no agent with that id.`,
      );
    }
    const enforced: LoadedAgent = { ...rootAgent, alwaysRun: true };
    const index = agents.findIndex((agent) => agent.id === id);
    if (index >= 0) {
      agents[index] = enforced;
    } else {
      agents.push(enforced);
    }
  }

  return {
    ...base,
    agents,
    auth: loadAuthFromRoot(rootConfig, manifest),
    breakGlassMarker: rootConfig.breakGlassMarker,
    commentTag,
    scopeName: scope.name,
  };
}

/**
 * Parse optional YAML-ish frontmatter (simple `key: value` scalars) from the top
 * of a markdown file. Returns the parsed keys and the body with frontmatter
 * stripped. Supports per-agent overrides like `model:` and `temperature:`.
 */
export function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  if (!md.startsWith("---")) {
    return { data: {}, body: md };
  }
  const end = md.indexOf("\n---", 3);
  if (end === -1) {
    return { data: {}, body: md };
  }
  const header = md.slice(3, end).trim();
  const body = md.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      data[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return { data, body };
}

/**
 * Strip // line and /* *\/ block comments from JSONC, ignoring anything inside
 * string literals. The config is trusted (in-repo), so a light scanner suffices.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += input[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (char === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += char;
    }
  }
  return out;
}

/** Remove trailing commas before `}`/`]` (JSONC), ignoring string contents. */
export function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += input[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) {
        j++;
      }
      if (input[j] === "}" || input[j] === "]") {
        continue; // drop the trailing comma
      }
    }
    out += char;
  }
  return out;
}
