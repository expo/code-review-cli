// @ref LLP 0006#loading-and-the-config-dir-escape-hatch — shared root/scope loader; ECR_CONFIG_DIR escape hatch
// @ref LLP 0006#model-resolution — REVIEWER_MODEL env override resolution
// @ref LLP 0006#auth-config-shapes — auth normalization (normalizeAuth, tokenEnvMismatch, loadAuthFromRoot)
// @ref LLP 0006#root-vs-scope-config — scope config loading, commentTag derivation, enforceAgents injection
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { ReviewConfigSchema, ScopeReviewConfigSchema } from "./schema.js";
import type { AuthConfigEntry } from "./schema.js";
import type {
  LoadedAgent,
  LoadedConfig,
  RawReviewConfig,
  RoutingManifest,
  RoutingScope,
} from "./schema.js";
import { toolMap } from "../core/tools.js";

export const CONFIG_DIRNAME = ".expo-code-review";

/** Stack config for a scope load (where `stack` is schema-rejected and absent). */
const STACK_CONFIG_DEFAULTS: LoadedConfig["stack"] = {
  enabled: false,
  maxDepth: 4,
  maxPrs: 8,
  maxFilesPerPr: 100,
  requireSameAuthor: true,
  confirmWithPatch: false,
  maxConfirmations: 10,
};

/** Feedback config for a scope load (where `feedback` is schema-rejected and absent). */
const FEEDBACK_CONFIG_DEFAULTS: LoadedConfig["feedback"] = {
  mode: "annotate",
  match: "both",
  dismiss: "never",
  protectedCategories: ["secrets", "security"],
  maxAdjudications: 10,
};

/** Research defaults for a scope load (where `research` is schema-rejected). */
const RESEARCH_CONFIG_DEFAULTS: LoadedConfig["research"] = {
  enabled: false,
  maxQueries: 8,
  resultsPerQuery: 2,
  timeoutMs: 30_000,
};

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
type ParsedConfig = Omit<
  RawReviewConfig,
  "auth" | "breakGlass" | "commentTag" | "stack" | "feedback" | "research"
> & {
  auth?: RawReviewConfig["auth"];
  breakGlass?: RawReviewConfig["breakGlass"];
  commentTag?: RawReviewConfig["commentTag"];
  stack?: RawReviewConfig["stack"];
  feedback?: RawReviewConfig["feedback"];
  research?: RawReviewConfig["research"];
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

  // An EMPTY REVIEWER_MODEL means "not set", not "use the empty model". GitHub Actions
  // passes `${{ vars.REVIEWER_MODEL }}` as an empty string whenever that repo variable
  // doesn't exist — which both scaffolded workflows do — so `??` (which only falls
  // through on null/undefined) silently replaced every configured model with "". Every
  // agent and the coordinator then ran on whatever OpenCode picked by default, so a
  // config saying `anthropic/claude-sonnet-5` reviewed with something else entirely and
  // nothing anywhere said so. Trim too: a stray newline is the same class of accident.
  // @ref LLP 0006#model-resolution [constrained-by] — never ??; GitHub Actions passes an unset var as empty string, not undefined
  const override = process.env.REVIEWER_MODEL?.trim() || undefined;
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
    const model = resolveModel(md.data.model);
    agents.push({
      id,
      description: md.data.description ?? "",
      alwaysRun: /^(true|yes|1)$/i.test(md.data.alwaysRun ?? ""),
      model,
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
    // Root-only: scope schemas reject research configuration, so an untrusted
    // subtree cannot select the index or alter the network-facing runtime.
    research: parsed.research ?? RESEARCH_CONFIG_DEFAULTS,
    // parsed.breakGlass/auth are always present for the root schema (defaults) and
    // absent for the scope schema; loadScopeConfig overrides both afterwards.
    breakGlassMarker: parsed.breakGlass?.marker ?? "/skip-review",
    // Scope configs can't declare commentTag (scope schema rejects it);
    // loadScopeConfig overwrites this placeholder with the manifest default.
    commentTag: parsed.commentTag ?? "expo-ai-code-reviewer",
    auth: normalizeAuth(parsed.auth),
    review: parsed.review,
    // Root-only: the scope schema rejects `stack`, so parsed.stack is absent for a
    // scope config and the defaults stand in (unused — the command layer reads the
    // ROOT config's stack values to drive the walk).
    stack: parsed.stack ?? STACK_CONFIG_DEFAULTS,
    // Root-only: the scope schema rejects `feedback`, so parsed.feedback is absent
    // for a scope config and the defaults stand in (unused — the command layer
    // reads the ROOT config's feedback values; the comment lifecycle is global).
    feedback: parsed.feedback ?? FEEDBACK_CONFIG_DEFAULTS,
  };
  return { config, raw: rawObject };
}

/**
 * Normalize either accepted `auth` shape (legacy single object, or the
 * per-provider `{ providers }` map) into the canonical entry list. Absent auth
 * means the schema default (api-key/openai, no tokenEnv).
 */
export function normalizeAuth(
  auth:
    | { mode: "api-key" | "oauth"; provider: string; tokenEnv?: string }
    | {
        providers: Record<
          string,
          { mode: "api-key" | "oauth"; tokenEnv?: string; upstream?: string }
        >;
      }
    | undefined,
): AuthConfigEntry[] {
  if (!auth) {
    return [{ provider: "openai", mode: "api-key" }];
  }
  if ("providers" in auth) {
    return Object.entries(auth.providers).map(([provider, entry]) => ({
      provider,
      mode: entry.mode,
      tokenEnv: entry.tokenEnv,
      upstream: entry.upstream,
    }));
  }
  return [{ provider: auth.provider, mode: auth.mode, tokenEnv: auth.tokenEnv }];
}

/**
 * Runtime auth lock: null when the entries' tokenEnv names equal the expected
 * comma-separated set exactly (order-insensitive), else a human-readable
 * mismatch. Set semantics because a multi-provider auth block names several
 * credential envs — a PR must not be able to add, drop, or repoint any of them.
 */
export function tokenEnvMismatch(auth: AuthConfigEntry[], expected: string): string | null {
  const declared = [
    ...new Set(auth.map((entry) => entry.tokenEnv).filter((v): v is string => Boolean(v))),
  ].sort();
  const expectedSet = [
    ...new Set(
      expected
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort();
  if (JSON.stringify(declared) === JSON.stringify(expectedSet)) {
    return null;
  }
  return `configured tokenEnv set [${declared.join(", ") || "(none)"}] != ECR_EXPECTED_TOKEN_ENV [${expectedSet.join(", ")}]`;
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
    return normalizeAuth(override);
  }
  return rootConfig.auth;
}

export interface LoadedScopeConfig extends LoadedConfig {
  scopeName: string;
}

/**
 * Whether a scope's own config dir exists under `root` — the same path
 * `loadScopeConfig` reads (deliberately NOT via resolveConfigDir: ECR_CONFIG_DIR
 * must never redirect scope subtrees). `ecr ci` uses this against the TRUSTED
 * BASE root to give scopes that are new in a PR a defined miss behavior (review
 * with the root config; the scope config activates after merge) instead of
 * failing the run on exactly the PR that introduces the scope.
 */
// @ref LLP 0006#loading-and-the-config-dir-escape-hatch [implements] — deliberately bypasses ECR_CONFIG_DIR; scope subtrees stay repo-root-relative
export function hasScopeConfig(root: string, scope: RoutingScope): boolean {
  if (scope.config === ".") {
    return true;
  }
  const dir = path.join(root, scope.config, CONFIG_DIRNAME);
  return existsSync(path.join(dir, "config.jsonc")) || existsSync(path.join(dir, "config.json"));
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

  // @ref LLP 0006#root-vs-scope-config [implements] — ROOT enforced agent always wins a same-id scope agent (risk 11)
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
    // Root-only, like stack: a non-default scope's `base` carries only the
    // hardcoded placeholder (the scope schema rejects `feedback`), so re-derive
    // from the root here or consumers of a nested scope's config would silently
    // run the default policy instead of the repo's real one.
    stack: rootConfig.stack,
    feedback: rootConfig.feedback,
    research: rootConfig.research,
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
