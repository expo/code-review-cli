// @ref LLP 0013#query-and-prompt-boundary [implements] — validate, bound, and sanitize reviewer-requested MCP evidence
// @ref LLP 0013#one-package-two-binaries [implements] — resolve the package-relative MCP entry instead of PATH/configured commands
// @ref LLP 0013#research-provenance-and-citations [implements] — bounded query/result audit records plus exact citation grounding
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LoadedConfig } from "../config/schema.js";
import { readResearchAudit } from "../research-mcp/audit.js";
import type { Finding, FindingSource, ResearchDecision } from "./schema.js";
export { OPENCODE_RESEARCH_TOOLS } from "./tools.js";

export type ResearchPlatform = "apple" | "android" | "react-native";

export interface ResearchQuery {
  platform: ResearchPlatform;
  providers: string[];
  query: string;
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

export const RESEARCH_DECISION_COUNT_LIMIT = 16;
export const RESEARCH_DECISION_BYTES_LIMIT = 20_000;

type GroundedResearchDecision = ResearchDecision & { agent: string };

export interface BoundedResearchDecisions {
  decisions: GroundedResearchDecision[];
  omitted: number;
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

/**
 * Bound the cross-agent decision channel after grounding. Reviewer tasks finish
 * concurrently, so sort before applying limits to keep the retained set stable.
 */
export function boundResearchDecisions(
  decisions: GroundedResearchDecision[],
): BoundedResearchDecisions {
  const sorted = [...decisions].sort((left, right) => {
    const leftKey = `${left.agent}\0${left.outcome}\0${left.summary}\0${left.sources[0]?.url ?? ""}`;
    const rightKey = `${right.agent}\0${right.outcome}\0${right.summary}\0${right.sources[0]?.url ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
  const kept = sorted.slice(0, RESEARCH_DECISION_COUNT_LIMIT);
  let omitted = sorted.length - kept.length;
  while (
    kept.length > 0 &&
    Buffer.byteLength(JSON.stringify(kept), "utf8") > RESEARCH_DECISION_BYTES_LIMIT
  ) {
    kept.pop();
    omitted++;
  }
  return { decisions: kept, omitted };
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
