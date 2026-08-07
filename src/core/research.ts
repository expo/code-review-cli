// @ref LLP 0013#query-and-prompt-boundary [implements] — derive identifiers only; validate, bound, and sanitize MCP evidence
// @ref LLP 0013#one-package-two-binaries [implements] — resolve the package-relative MCP entry instead of PATH/configured commands
// @ref LLP 0013#research-provenance-and-citations [implements] — bounded query/result audit records plus exact citation grounding
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { LoadedConfig } from "../config/schema.js";
import { readResearchAudit } from "../research-mcp/audit.js";
import { run } from "./exec.js";
import type { Finding, FindingSource, ResearchDecision } from "./schema.js";
export { OPENCODE_RESEARCH_TOOLS } from "./tools.js";

export type ResearchPlatform = "apple" | "android" | "react-native";

export interface ResearchQuery {
  platform: ResearchPlatform;
  providers: string[];
  query: string;
}

export interface ResearchInputFile {
  path: string;
  patch: string;
}

export interface ResearchEvidence {
  id?: string;
  query: ResearchQuery;
  provider: string;
  sourceKind: string;
  title: string;
  url: string;
  passage: string;
  availability?: string[];
}

export interface ResearchRun {
  queries: ResearchQuery[];
  evidence: ResearchEvidence[];
  warnings: string[];
  promptText: string;
}

export interface ResearchResultRecord {
  id?: string;
  query: ResearchQuery;
  provider: string;
  sourceKind: string;
  title: string;
  url: string;
  passage: string;
  availability?: string[];
}

export interface ResearchProvenance {
  queries: ResearchQuery[];
  results: ResearchResultRecord[];
  warnings: string[];
  /** Grounded reviewer declarations that documentation changed a concrete decision. */
  decisions?: Array<ResearchDecision & { agent: string }>;
  usefulness?: ResearchUsefulness;
  error?: string;
}

export interface ResearchUsefulness {
  finalFindingsWithSources: number;
  citedResultCount: number;
  supportedFindingCandidates: number;
  dismissedCandidates: number;
  decisionResultCount: number;
  utilizedResultCount: number;
  unusedResultCount: number;
}

export const RESEARCH_MCP_SERVER_NAME = "platform_docs";
export const CLAUDE_RESEARCH_TOOLS = [
  `mcp__${RESEARCH_MCP_SERVER_NAME}__search_platform_docs`,
  `mcp__${RESEARCH_MCP_SERVER_NAME}__fetch_platform_doc`,
] as const;
export interface ResearchMcpRuntime {
  auditPath: string;
  claudeConfigPath: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
  cleanup(): Promise<void>;
}

const APPLE_EXTENSIONS = /\.(?:swift|m|mm)$/i;
const ANDROID_EXTENSIONS = /\.(?:kt|java|gradle|gradle\.kts)$/i;
const REACT_NATIVE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;
const QUERY_TOKEN = /[A-Za-z][A-Za-z0-9_.:-]{1,79}/g;
const MAX_ANALYZED_PATCH_LINE_LENGTH = 4096;
const TYPE_TOKEN = /\b[A-Z][A-Za-z0-9_]{2,}(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
const MEMBER_TOKEN = /\.([a-z][A-Za-z0-9_]{3,})\s*(?:\(|\b)/g;
const ECOSYSTEM_CALL_TOKEN =
  /\b((?:create|enable|make|measure|run|schedule|scrollTo|use|with)[A-Z][A-Za-z0-9_]*)\s*\(/g;
const IGNORED_TYPES = new Set([
  "Array",
  "Bool",
  "Boolean",
  "Class",
  "Data",
  "Double",
  "Error",
  "Exception",
  "Float",
  "Int",
  "Integer",
  "List",
  "Long",
  "Map",
  "Object",
  "Promise",
  "Set",
  "String",
  "URL",
  "Unit",
]);
const IGNORED_MEMBERS = new Set([
  "apply",
  "build",
  "copy",
  "equals",
  "filter",
  "first",
  "get",
  "hashCode",
  "invoke",
  "last",
  "let",
  "map",
  "remove",
  "run",
  "set",
  "toString",
]);

type LexicalMode =
  | "code"
  | "block-comment"
  | "single-quote"
  | "double-quote"
  | "template"
  | "triple-single-quote"
  | "triple-double-quote";

interface LexicalState {
  mode: LexicalMode;
  escaped: boolean;
  moduleSpecifier: string | null;
}

interface AddedPatchAnalysis {
  codeLines: string[];
  providerSignals: string;
}

function startsModuleSpecifier(code: string): boolean {
  return /(?:\b(?:from|import)\s*|\brequire\s*\(\s*)$/.test(code);
}

function analyzePatchLine(
  source: string,
  state: LexicalState,
  collectProviderSignals: boolean,
  providerSignals: string[],
): string {
  let code = "";

  const finishModuleSpecifier = () => {
    const value = state.moduleSpecifier;
    if (value && /^[A-Za-z0-9@._/+~-]{1,200}$/.test(value)) providerSignals.push(value);
    state.moduleSpecifier = null;
  };

  for (let index = 0; index < source.length;) {
    if (state.mode === "block-comment") {
      if (source.startsWith("*/", index)) {
        state.mode = "code";
        code += "  ";
        index += 2;
      } else {
        code += " ";
        index++;
      }
      continue;
    }

    if (state.mode === "triple-single-quote" || state.mode === "triple-double-quote") {
      const delimiter = state.mode === "triple-single-quote" ? "'''" : '"""';
      if (source.startsWith(delimiter, index)) {
        state.mode = "code";
        code += "   ";
        index += 3;
      } else {
        code += " ";
        index++;
      }
      continue;
    }

    if (
      state.mode === "single-quote" ||
      state.mode === "double-quote" ||
      state.mode === "template"
    ) {
      const delimiter =
        state.mode === "single-quote" ? "'" : state.mode === "double-quote" ? '"' : "`";
      const character = source[index]!;
      if (state.escaped) {
        if (state.moduleSpecifier !== null) state.moduleSpecifier += character;
        state.escaped = false;
        code += " ";
        index++;
      } else if (character === "\\") {
        state.escaped = true;
        code += " ";
        index++;
      } else if (character === delimiter) {
        finishModuleSpecifier();
        state.mode = "code";
        code += " ";
        index++;
      } else {
        if (state.moduleSpecifier !== null) state.moduleSpecifier += character;
        code += " ";
        index++;
      }
      continue;
    }

    if (source.startsWith("//", index)) {
      code += " ".repeat(source.length - index);
      break;
    }
    if (source.startsWith("/*", index)) {
      state.mode = "block-comment";
      code += "  ";
      index += 2;
      continue;
    }
    if (source.startsWith("'''", index) || source.startsWith('"""', index)) {
      state.mode = source.startsWith("'''", index) ? "triple-single-quote" : "triple-double-quote";
      state.moduleSpecifier = null;
      code += "   ";
      index += 3;
      continue;
    }
    const character = source[index]!;
    if (character === "'" || character === '"' || character === "`") {
      state.mode =
        character === "'" ? "single-quote" : character === '"' ? "double-quote" : "template";
      state.escaped = false;
      state.moduleSpecifier =
        collectProviderSignals && character !== "`" && startsModuleSpecifier(code) ? "" : null;
      code += " ";
      index++;
      continue;
    }
    code += character;
    index++;
  }

  // JavaScript/TypeScript, Swift, and Kotlin single/double-quoted strings do not
  // continue onto the next physical line unless the final character escapes the
  // newline. Reset malformed prose-like quotes (notably JSX apostrophes) here so
  // they cannot invert how later patch lines are classified. Templates, triple
  // quotes, and block comments intentionally retain their multiline state.
  const continuesQuotedLine =
    (state.mode === "single-quote" || state.mode === "double-quote") && state.escaped;
  if ((state.mode === "single-quote" || state.mode === "double-quote") && !continuesQuotedLine) {
    state.mode = "code";
    state.moduleSpecifier = null;
  }
  state.escaped = false;
  return code.trim();
}

/**
 * Analyze the resulting side of a unified diff while keeping lexical state across
 * lines. Provider routing may retain only import/require module specifiers; those
 * strings are kept separate and can never become outbound query text.
 */
function analyzeAddedPatch(patch: string): AddedPatchAnalysis {
  const codeLines: string[] = [];
  const providerSignals: string[] = [];
  const state: LexicalState = { mode: "code", escaped: false, moduleSpecifier: null };

  for (const patchLine of patch.split("\n")) {
    if (patchLine.startsWith("@@")) {
      state.mode = "code";
      state.escaped = false;
      state.moduleSpecifier = null;
      continue;
    }
    if (patchLine.startsWith("+++") || patchLine.startsWith("---")) continue;
    const isAdded = patchLine.startsWith("+");
    const isContext = patchLine.startsWith(" ");
    if (!isAdded && !isContext) continue;
    const source = patchLine.slice(1);
    if (source.length > MAX_ANALYZED_PATCH_LINE_LENGTH) {
      // A quote startsModuleSpecifier check examines the accumulated line prefix.
      // Stop this file before an attacker-controlled giant line can turn that
      // bounded research prepass into quadratic work. Abandoning later lines also
      // avoids guessing whether the skipped input opened a multiline literal.
      break;
    }
    const code = analyzePatchLine(source, state, isAdded, providerSignals);
    if (isAdded && code) codeLines.push(code);
  }

  return {
    codeLines,
    providerSignals: providerSignals.join("\n").slice(0, 256_000).toLowerCase(),
  };
}

function normalizeQuery(parts: string[]): string {
  const tokens = parts.join(" ").match(QUERY_TOKEN) ?? [];
  return [...new Set(tokens)].join(" ").slice(0, 120).trim();
}

function platformFor(file: ResearchInputFile): ResearchPlatform | null {
  const normalized = file.path.replace(/\\/g, "/");
  if (APPLE_EXTENSIONS.test(normalized) || /(?:^|\/)ios(?:\/|$)/i.test(normalized)) {
    return "apple";
  }
  if (ANDROID_EXTENSIONS.test(normalized) || /(?:^|\/)android(?:\/|$)/i.test(normalized)) {
    return "android";
  }
  if (REACT_NATIVE_EXTENSIONS.test(normalized)) return "react-native";
  return null;
}

const REACT_NATIVE_PROVIDERS = new Set([
  "expo",
  "react-native",
  "react-native-reanimated",
  "react-native-gesture-handler",
  "react-native-screens",
  "react-native-worklets",
]);

function providersFor(file: ResearchInputFile, code: string, signals: string): string[] {
  const path = file.path.toLowerCase();
  const text = code.toLowerCase();
  const platform = platformFor(file);
  const providers: string[] = [];
  const add = (provider: string, matches: boolean) => {
    if (matches && !providers.includes(provider)) providers.push(provider);
  };

  // Native source is owned by the native platform first. An Expo package path is
  // repository ownership, not documentation ownership: packages/expo-image/ios
  // must search Apple and SDWebImage contracts rather than Expo's JavaScript docs.
  if (platform === "apple") add("apple", true);
  if (platform === "android") add("android", true);

  if (platform === "react-native") {
    add(
      "react-native-reanimated",
      /react-native-reanimated/.test(signals) || path.includes("react-native-reanimated"),
    );
    add(
      "react-native-gesture-handler",
      /react-native-gesture-handler/.test(signals) || path.includes("react-native-gesture-handler"),
    );
    add(
      "react-native-screens",
      /react-native-screens/.test(signals) || path.includes("react-native-screens"),
    );
    add(
      "react-native-worklets",
      /react-native-worklets/.test(signals) || path.includes("react-native-worklets"),
    );
    add(
      "expo",
      /(?:^|\n)(?:expo|expo-[a-z0-9-]+|@expo\/[a-z0-9-]+)(?:\n|$)/.test(signals) ||
        /(?:^|\/)packages\/expo(?:-[^/]+)?(?:\/|$)/.test(path),
    );
    add("react-native", /(?:^|\n)react-native(?:\/[^\n]+)?(?:\n|$)/.test(signals));
  }

  // Explicit framework/dependency signals are additive. Keeping the platform
  // provider alongside the dependency lets one pass check both the OS contract and
  // the wrapper/library behavior without a package-path heuristic hiding either.
  if (platform === "apple") {
    add("sdwebimage", /\bsdwebimage(?:manager|options|context|cache|loader)?\b/.test(text));
    add("expo", /\bexpomodulescore\b/.test(text));
  }
  if (platform === "android") {
    add("media3", /androidx\.media3|mediasessionservice|\bexoplayer\b/.test(text));
    add("glide", /com\.bumptech\.glide|\bglide\b/.test(text));
    add("okhttp", /okhttp3|\bokhttpclient\b|\brequest\.builder\b/.test(text));
    add(
      "kotlin-coroutines",
      /kotlinx\.coroutines|\bcoroutinescope\b|\bmutable(?:state|shared)flow\b/.test(text),
    );
    const isGradle = /\.gradle(?:\.kts)?$/.test(path) || /(?:^|\/)build\.gradle/.test(path);
    add("agp", isGradle && /com\.android|android\s*\{|compilesdk|targetsdk/.test(text));
    add("gradle", isGradle);
    add("expo", /\bexpo\.modules\.kotlin\b/.test(text));
  }

  return providers.length > 0 ? providers : ["react-native"];
}

function lineQuery(line: string): string | null {
  const declared = line.match(
    /\b(?:class|struct|enum|interface|protocol)\s+([A-Z][A-Za-z0-9_]*)/,
  )?.[1];
  const types = [...line.matchAll(TYPE_TOKEN)]
    .map((match) => match[0]!)
    .filter((value) => value !== declared && !IGNORED_TYPES.has(value.split(".")[0]!));
  if (types.length === 0) {
    const call = [...line.matchAll(ECOSYSTEM_CALL_TOKEN)][0]?.[1];
    return call ? normalizeQuery([call]) : null;
  }
  const members = [...line.matchAll(MEMBER_TOKEN)]
    .map((match) => match[1]!)
    .filter((value) => !IGNORED_MEMBERS.has(value));
  const primary = types[0]!;
  const member = members.find((value) => !primary.toLowerCase().includes(value.toLowerCase()));
  return normalizeQuery(member ? [primary, member] : [primary]);
}

function addQuery(
  target: ResearchQuery[],
  seen: Set<string>,
  platform: ResearchPlatform,
  providers: string[],
  query: string,
): void {
  const normalized = normalizeQuery([query]);
  if (!normalized) return;
  const key = `${platform}|${providers.join(",")}|${normalized.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ platform, providers, query: normalized });
}

/**
 * Derive bounded documentation searches from code identifiers only. String literals,
 * comments, removed lines, paths, and raw source snippets never become query text.
 */
export function deriveResearchQueries(files: ResearchInputFile[], maxQueries = 8): ResearchQuery[] {
  const queries: ResearchQuery[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const platform = platformFor(file);
    if (!platform) continue;
    const { codeLines: lines, providerSignals } = analyzeAddedPatch(file.patch);
    const code = lines.join("\n").slice(0, 256_000);
    const providers = providersFor(file, code, providerSignals);

    for (const provider of providers) {
      let addedForProvider = 0;
      for (const line of lines) {
        const query = lineQuery(line);
        if (!query) continue;
        const before = queries.length;
        addQuery(
          queries,
          seen,
          REACT_NATIVE_PROVIDERS.has(provider) ? "react-native" : platform,
          [provider],
          query,
        );
        if (queries.length > before && ++addedForProvider >= 2) break;
        if (queries.length >= maxQueries) return queries;
      }
    }

    if (
      platform === "apple" &&
      /\b(?:actor|MainActor|Sendable|TaskGroup|Task\.sleep)\b/.test(code)
    ) {
      const concept = code.match(/\b(?:MainActor|Sendable|TaskGroup|actor|Task\.sleep)\b/)?.[0];
      if (concept) addQuery(queries, seen, "apple", ["swift-evolution"], concept);
    }
    if (platform === "android" && /\b(?:VERSION_CODES|SDK_INT|targetSdk|compileSdk)\b/.test(code)) {
      const api = code.match(
        /\b(?:VERSION_CODES(?:\.[A-Z_]+)?|SDK_INT|targetSdk|compileSdk)\b/,
      )?.[0];
      if (api) addQuery(queries, seen, "android", ["android-releases"], api);
    }
    if (queries.length >= maxQueries) return queries.slice(0, maxQueries);
  }
  return queries.slice(0, maxQueries);
}

const ToolResultSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
});

const SearchPayloadSchema = z.object({
  warnings: z.array(z.string().max(500)).max(10).optional(),
  results: z.array(
    z.object({
      id: z.string().min(1).max(240).optional(),
      provider: z.string().min(1).max(80),
      sourceKind: z.string().min(1).max(80),
      title: z.string().min(1).max(500),
      url: z.string().url().max(2_000),
      passage: z.string().max(5_000),
      availability: z.array(z.string().max(240)).max(20).optional(),
    }),
  ),
});

const RESEARCH_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const RESEARCH_SEARCH_API_KEY = "BRAVE_SEARCH_API_KEY";

export function researchChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(process.platform === "win32" && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
  };
  for (const key of RESEARCH_PROXY_ENV_KEYS) {
    if (source[key]) environment[key] = source[key];
  }
  if (source[RESEARCH_SEARCH_API_KEY]) {
    environment[RESEARCH_SEARCH_API_KEY] = source[RESEARCH_SEARCH_API_KEY];
  }
  return environment;
}

export function bundledResearchServer(): { command: string; args: string[] } {
  const builtEntry = fileURLToPath(new URL("../research-mcp/cli.js", import.meta.url));
  const sourceEntry = fileURLToPath(new URL("../research-mcp/cli.ts", import.meta.url));
  return {
    command: process.execPath,
    args: [existsSync(builtEntry) ? builtEntry : sourceEntry],
  };
}

/**
 * Create one owner-only MCP configuration and append-only audit for a review run.
 * The model process receives only the config path; the Brave credential is passed
 * directly to the bounded MCP child and never added to the model process env.
 */
export async function createResearchMcpRuntime(
  config: LoadedConfig["research"],
): Promise<ResearchMcpRuntime | undefined> {
  if (!config.enabled) return undefined;
  const directory = await mkdtemp(path.join(tmpdir(), "ecr-research-"));
  const auditPath = path.join(directory, "audit.jsonl");
  const claudeConfigPath = path.join(directory, "mcp.json");
  const server = bundledResearchServer();
  const args = [
    ...server.args,
    "serve",
    ...(config.indexPath ? ["--index", config.indexPath] : []),
  ];
  const child = researchChildEnvironment();
  const environment = Object.fromEntries(
    Object.entries({
      ...child,
      REVIEW_RESEARCH_AUDIT_PATH: auditPath,
      REVIEW_RESEARCH_MAX_CALLS: String(config.maxQueries),
      REVIEW_RESEARCH_MAX_RESULTS: String(config.resultsPerQuery),
    }).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
  await writeFile(
    claudeConfigPath,
    `${JSON.stringify({
      mcpServers: {
        [RESEARCH_MCP_SERVER_NAME]: {
          type: "stdio",
          command: server.command,
          args,
          env: environment,
        },
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    auditPath,
    claudeConfigPath,
    command: server.command,
    args,
    environment,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function researchProvenanceFromAudit(
  auditPath: string,
): Promise<{ provenance: ResearchProvenance; evidence: ResearchEvidence[] }> {
  const records = await readResearchAudit(auditPath);
  const queries: ResearchQuery[] = [];
  const evidence: ResearchEvidence[] = [];
  const warnings: string[] = [];
  for (const record of records) {
    const firstResult = record.results[0];
    const platformValue = record.input.platform ?? firstResult?.platform ?? "react-native";
    const platform: ResearchPlatform =
      platformValue === "apple" || platformValue === "android" ? platformValue : "react-native";
    const providers =
      record.input.providers ??
      record.results.flatMap((result) => (result.provider ? [result.provider] : []));
    const query: ResearchQuery = {
      platform,
      providers: [...new Set(providers)],
      query: record.input.query ?? record.input.url ?? record.tool,
    };
    queries.push(query);
    warnings.push(...record.warnings);
    if (record.error) warnings.push(`${record.tool}: ${record.error}`);
    for (const result of record.results) {
      if (!result.provider || !result.sourceKind) continue;
      evidence.push({
        id: result.id,
        query,
        provider: result.provider,
        sourceKind: result.sourceKind,
        title: result.title,
        url: result.url,
        passage: result.passage,
        ...(result.availability ? { availability: result.availability } : {}),
      });
    }
  }
  const run: ResearchRun = {
    queries,
    evidence,
    warnings: [...new Set(warnings)].slice(0, 10),
    promptText: "",
  };
  return { provenance: toResearchProvenance(run), evidence };
}

function cleanEvidenceText(value: string, maxLength: number): string {
  return (
    value
      .replace(/^\s*-{3,}\s*(?:BEGIN|END)\s+PLATFORM RESEARCH.*$/gim, "")
      .replace(/`{3,}/g, "'''")
      .replace(/<\/?\s*(?:system|user|assistant|instructions?|prompt|tool)[^>]*>/gi, "")
      // oxlint-disable-next-line no-control-regex -- intentional prompt-data sanitization
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .slice(0, maxLength)
      .trim()
  );
}

export function formatResearchEvidence(evidence: ResearchEvidence[]): string {
  if (evidence.length === 0) return "";
  const body = evidence
    .map((item) => {
      const availability = item.availability?.length
        ? `\nAvailability: ${cleanEvidenceText(item.availability.join(", "), 500)}`
        : "";
      return [
        `Query: ${cleanEvidenceText(item.query.query, 120)}`,
        `Provider: ${cleanEvidenceText(item.provider, 80)} (${cleanEvidenceText(item.sourceKind, 80)})`,
        `Source: ${cleanEvidenceText(item.title, 240)} — ${item.url}${availability}`,
        "Passage:",
        cleanEvidenceText(item.passage, 1200),
      ].join("\n");
    })
    .join("\n\n");
  return cleanEvidenceText(body, 16_000);
}

function researchQueryKey(query: ResearchQuery): string {
  return `${query.platform}\0${query.providers.join(",")}\0${query.query}`;
}

export function toResearchProvenance(run: ResearchRun): ResearchProvenance {
  return {
    queries: run.queries,
    results: run.evidence.map((item) => ({
      ...(item.id ? { id: cleanEvidenceText(item.id, 240) } : {}),
      query: item.query,
      provider: cleanEvidenceText(item.provider, 80),
      sourceKind: cleanEvidenceText(item.sourceKind, 80),
      title: cleanEvidenceText(item.title, 240),
      url: item.url,
      passage: cleanEvidenceText(item.passage, 20_000),
      ...(item.availability?.length
        ? { availability: item.availability.map((value) => cleanEvidenceText(value, 240)) }
        : {}),
    })),
    warnings: run.warnings.map((warning) => cleanEvidenceText(warning, 500)),
  };
}

export function formatResearchProgress(provenance: ResearchProvenance): string[] {
  const lines = [
    `  research: ${provenance.results.length} result(s) from ${provenance.queries.length} bounded query(s)`,
  ];
  const byQuery = new Map<string, ResearchResultRecord[]>();
  for (const result of provenance.results) {
    const key = researchQueryKey(result.query);
    const bucket = byQuery.get(key) ?? [];
    bucket.push(result);
    byQuery.set(key, bucket);
  }
  for (const [index, query] of provenance.queries.entries()) {
    lines.push(
      `  research query ${index + 1}/${provenance.queries.length} — ${query.platform} [${query.providers.join(", ")}]: ${cleanEvidenceText(query.query, 120)}`,
    );
    const results = byQuery.get(researchQueryKey(query)) ?? [];
    if (results.length === 0) {
      lines.push("    result: none");
      continue;
    }
    for (const result of results) {
      lines.push(
        `    result: ${cleanEvidenceText(result.title, 160)} (${result.provider}/${result.sourceKind}) — ${result.url}`,
      );
    }
  }
  for (const warning of provenance.warnings) {
    lines.push(`  research warning: ${cleanEvidenceText(warning, 500)}`);
  }
  if (provenance.error) {
    lines.push(`  research error: ${cleanEvidenceText(provenance.error, 500)}`);
  }
  return lines;
}

function escapeMarkdownLabel(value: string): string {
  return cleanEvidenceText(value, 240)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\[\]])/g, "\\$1");
}

export function renderResearchMarkdown(provenance: ResearchProvenance): string {
  const lines = [
    "### 🔎 Documentation research",
    "",
    `${provenance.results.length} result(s) from ${provenance.queries.length} bounded query(s).`,
    "",
  ];
  const byQuery = new Map<string, ResearchResultRecord[]>();
  for (const result of provenance.results) {
    const key = researchQueryKey(result.query);
    const bucket = byQuery.get(key) ?? [];
    bucket.push(result);
    byQuery.set(key, bucket);
  }
  for (const query of provenance.queries) {
    lines.push(
      `- \`${cleanEvidenceText(query.query, 120)}\` — ${query.platform}; ${query.providers.join(", ")}`,
    );
    const results = byQuery.get(researchQueryKey(query)) ?? [];
    if (results.length === 0) {
      lines.push("  - _No allowlisted result._");
      continue;
    }
    for (const result of results) {
      lines.push(
        `  - [${escapeMarkdownLabel(result.title)}](<${result.url}>) — ${escapeMarkdownLabel(result.provider)}/${escapeMarkdownLabel(result.sourceKind)}`,
      );
    }
  }
  for (const warning of provenance.warnings) {
    lines.push(`- ⚠️ ${escapeMarkdownLabel(warning)}`);
  }
  if (provenance.error) {
    lines.push(`- ⚠️ Research failed: ${escapeMarkdownLabel(provenance.error)}`);
  }
  return lines.join("\n");
}

export function mergeResearchSources(
  ...groups: Array<readonly FindingSource[] | undefined>
): FindingSource[] {
  const seen = new Set<string>();
  return groups
    .flatMap((group) => group ?? [])
    .filter((source) => {
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    })
    .slice(0, 5);
}

/** Keep only exact URLs returned by this review's MCP calls and restore canonical titles. */
export function groundResearchSources(
  findings: Finding[],
  evidence: ResearchEvidence[],
): Finding[] {
  const allowed = new Map(
    evidence.map((item) => [
      item.url,
      { title: cleanEvidenceText(item.title, 240), url: item.url },
    ]),
  );
  return findings.map((finding) => {
    const { sources: claimed, ...withoutSources } = finding;
    const sources = mergeResearchSources(
      claimed?.flatMap((source) => {
        const canonical = allowed.get(source.url);
        return canonical ? [canonical] : [];
      }),
    );
    return sources.length > 0 ? { ...withoutSources, sources } : withoutSources;
  });
}

/**
 * Keep only reviewer decisions backed by an exact URL from this run's MCP audit.
 * An ungrounded declaration is discarded so model output cannot inflate usefulness.
 */
export function groundResearchDecisions(
  decisions: ResearchDecision[],
  evidence: ResearchEvidence[],
  agent: string,
): Array<ResearchDecision & { agent: string }> {
  const allowed = new Map(
    evidence.map((item) => [
      item.url,
      { title: cleanEvidenceText(item.title, 240), url: item.url },
    ]),
  );
  return decisions.flatMap((decision) => {
    const sources = mergeResearchSources(
      decision.sources.flatMap((source) => {
        const canonical = allowed.get(source.url);
        return canonical ? [canonical] : [];
      }),
    );
    if (sources.length === 0) return [];
    return [
      {
        outcome: decision.outcome,
        summary: cleanEvidenceText(decision.summary, 240),
        sources,
        agent: cleanEvidenceText(agent, 120),
      },
    ];
  });
}

/** Count unique audited results that materially affected the final review. */
export function summarizeResearchUsefulness(
  provenance: ResearchProvenance,
  findings: Finding[],
): ResearchUsefulness {
  const resultUrls = new Set(provenance.results.map((result) => result.url));
  const citedUrls = new Set(
    findings.flatMap((finding) =>
      (finding.sources ?? []).flatMap((source) => (resultUrls.has(source.url) ? [source.url] : [])),
    ),
  );
  const decisions = provenance.decisions ?? [];
  const decisionUrls = new Set(
    decisions.flatMap((decision) =>
      decision.sources.flatMap((source) => (resultUrls.has(source.url) ? [source.url] : [])),
    ),
  );
  const utilizedUrls = new Set([...citedUrls, ...decisionUrls]);
  return {
    finalFindingsWithSources: findings.filter((finding) =>
      (finding.sources ?? []).some((source) => resultUrls.has(source.url)),
    ).length,
    citedResultCount: citedUrls.size,
    supportedFindingCandidates: decisions.filter(
      (decision) => decision.outcome === "supported-finding",
    ).length,
    dismissedCandidates: decisions.filter((decision) => decision.outcome === "dismissed-candidate")
      .length,
    decisionResultCount: decisionUrls.size,
    utilizedResultCount: utilizedUrls.size,
    unusedResultCount: Math.max(0, resultUrls.size - utilizedUrls.size),
  };
}

export function formatResearchUsefulness(usefulness: ResearchUsefulness): string {
  return (
    `  research usefulness: ${usefulness.finalFindingsWithSources} final finding(s) cited ` +
    `${usefulness.citedResultCount} unique result(s); ` +
    `${usefulness.supportedFindingCandidates} supported and ` +
    `${usefulness.dismissedCandidates} dismissed candidate(s); ` +
    `${usefulness.utilizedResultCount} result(s) materially used, ` +
    `${usefulness.unusedResultCount} unused`
  );
}

export function renderResearchUsefulnessMarkdown(provenance: ResearchProvenance): string {
  const usefulness = provenance.usefulness;
  if (!usefulness) return "";
  const totalUniqueResults = usefulness.utilizedResultCount + usefulness.unusedResultCount;
  const lines = [
    "### 📚 Documentation research usefulness",
    "",
    `- Final findings with grounded citations: **${usefulness.finalFindingsWithSources}**`,
    `- Unique results cited by final findings: **${usefulness.citedResultCount}**`,
    `- Candidate decisions: **${usefulness.supportedFindingCandidates} supported**, **${usefulness.dismissedCandidates} dismissed**`,
    `- Unique results materially used: **${usefulness.utilizedResultCount}/${totalUniqueResults}**`,
  ];
  if (provenance.decisions?.length) {
    lines.push("", "Grounded candidate decisions:");
    for (const decision of provenance.decisions) {
      const sources = decision.sources
        .map((source) => `[${escapeMarkdownLabel(source.title)}](<${source.url}>)`)
        .join(", ");
      lines.push(
        `- **${decision.outcome === "supported-finding" ? "Supported finding" : "Dismissed candidate"}** (${escapeMarkdownLabel(decision.agent)}): ${escapeMarkdownLabel(decision.summary)} — ${sources}`,
      );
    }
  }
  return lines.join("\n");
}

export async function collectPlatformResearch(
  files: ResearchInputFile[],
  config: LoadedConfig["research"],
): Promise<ResearchRun> {
  const queries = deriveResearchQueries(files, config.maxQueries);
  if (!config.enabled || queries.length === 0) {
    return { queries, evidence: [], warnings: [], promptText: "" };
  }

  const calls = queries.map((query, index) => ({
    jsonrpc: "2.0",
    id: index + 2,
    method: "tools/call",
    params: {
      name: "search_platform_docs",
      arguments: {
        platform: query.platform,
        providers: query.providers,
        query: query.query,
        limit: config.resultsPerQuery,
      },
    },
  }));
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "expo-code-review-cli", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    ...calls,
  ];

  const server = bundledResearchServer();
  const serverArgs = [
    ...server.args,
    "serve",
    ...(config.indexPath ? ["--index", config.indexPath] : []),
  ];
  const result = await run(server.command, serverArgs, {
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    cwd: tmpdir(),
    env: researchChildEnvironment(),
    timeout: config.timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    check: false,
  });
  if (result.timedOut) throw new Error("platform research MCP timed out");
  if (result.overflowed) throw new Error("platform research MCP output exceeded 2 MB");
  if (result.code !== 0) {
    throw new Error(`platform research MCP exited ${result.code}: ${result.stderr.slice(0, 500)}`);
  }

  const responses = new Map<number, unknown>();
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof parsed.id === "number") {
      if (parsed.error) throw new Error(`platform research MCP error for request ${parsed.id}`);
      responses.set(parsed.id, parsed.result);
    }
  }
  if (!responses.has(1)) throw new Error("platform research MCP did not initialize");

  const evidence: ResearchEvidence[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index]!;
    const toolResult = ToolResultSchema.parse(responses.get(index + 2));
    const text = toolResult.content.find((block) => block.type === "text")?.text;
    if (!text) continue;
    const payload = SearchPayloadSchema.parse(JSON.parse(text));
    warnings.push(
      ...(payload.warnings ?? []).map((warning) => cleanEvidenceText(warning, 500)).filter(Boolean),
    );
    for (const item of payload.results.slice(0, config.resultsPerQuery)) {
      if (!item.url.startsWith("https://") || !query.providers.includes(item.provider)) continue;
      evidence.push({ query, ...item });
    }
  }

  return {
    queries,
    evidence,
    warnings: [...new Set(warnings)].slice(0, 10),
    promptText: formatResearchEvidence(evidence),
  };
}
