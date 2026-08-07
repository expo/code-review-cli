import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { extractAppleDocCPage } from "./apple-docc.js";
import { chunkDocument, extractDocumentationPage } from "./html.js";
import { extractMarkdownDocumentationPage } from "./markdown.js";
import {
  getProvider,
  resolveAllowedRequestUrl,
  resolveAllowedUrl,
  type DocumentationProvider,
} from "./providers.js";
import { buildSearchIndex, writeSearchIndex } from "./search-index.js";
import { extractYouTrackIssue } from "./youtrack.js";
import {
  PLATFORMS,
  PROVIDERS,
  SOURCE_KINDS,
  type DiscoveredDocument,
  type IndexedChunk,
  type Platform,
  type ProviderId,
  type SourceDefinition,
  type SourcesConfig,
} from "./types.js";

const sourcesConfigSchema = z.object({
  output: z.string().min(1),
  crawl: z.object({
    maxPagesPerProvider: z.number().int().min(1).max(100_000),
    maxDepth: z.number().int().min(0).max(20),
    delayMs: z.number().int().min(0).max(60_000),
    timeoutMs: z.number().int().min(100).max(120_000),
    maxResponseBytes: z.number().int().min(1_024).max(20_000_000),
  }),
  sources: z
    .array(
      z.object({
        provider: z.enum(PROVIDERS),
        sourceKind: z.enum(SOURCE_KINDS),
        seedUrls: z.array(z.string().url()).min(1),
        maxPages: z.number().int().min(1).max(100_000).optional(),
        maxDepth: z.number().int().min(0).max(20).optional(),
      }),
    )
    .min(1),
});

interface CrawlItem {
  url: URL;
  depth: number;
}

interface CrawlResult {
  provider: ProviderId;
  platform: Platform;
  documents: DiscoveredDocument[];
  errors: string[];
}

export interface UpdateOptions {
  configPath: string;
  outputPath?: string;
  platforms?: Platform[];
  maxPagesPerProvider?: number;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBodyWithLimit(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maximumBytes) {
    throw new Error(`response is ${contentLength} bytes; limit is ${maximumBytes}`);
  }
  if (!response.body) {
    throw new Error("response has no body");
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error(`response exceeded the ${maximumBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

async function fetchAllowedContent(
  provider: DocumentationProvider,
  documentUrl: URL,
  limits: SourcesConfig["crawl"],
): Promise<string> {
  let currentUrl = resolveAllowedRequestUrl(provider, provider.requestUrl(documentUrl).href);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(limits.timeoutMs),
      headers: {
        "accept-language": "en-US,en;q=0.9",
        accept: (() => {
          const format = provider.responseFormat(documentUrl);
          if (format === "docc-json" || format === "youtrack-json") {
            return "application/json";
          }
          if (format === "markdown") {
            return "text/markdown,text/plain;q=0.9";
          }
          return "text/html,application/xhtml+xml;q=0.9";
        })(),
        "user-agent": "review-research-mcp/0.1 (+local documentation indexer)",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`redirect ${response.status} did not include Location`);
      }
      currentUrl = resolveAllowedRequestUrl(provider, location, currentUrl.href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const expectedFormat = provider.responseFormat(documentUrl);
    const isExpectedType =
      expectedFormat === "docc-json" || expectedFormat === "youtrack-json"
        ? contentType.includes("json")
        : expectedFormat === "markdown"
          ? contentType.includes("text/plain") || contentType.includes("text/markdown")
          : contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    if (!isExpectedType) {
      throw new Error(`unsupported content type: ${contentType || "missing"}`);
    }
    return readBodyWithLimit(response, limits.maxResponseBytes);
  }
  throw new Error("too many redirects");
}

async function crawlProvider(
  provider: DocumentationProvider,
  source: SourceDefinition,
  limits: SourcesConfig["crawl"],
): Promise<CrawlResult> {
  const queue: CrawlItem[] = source.seedUrls.map((url) => ({
    url: resolveAllowedUrl(provider, url),
    depth: 0,
  }));
  const queued = new Set(queue.map((item) => item.url.href));
  const visited = new Set<string>();
  const documents: DiscoveredDocument[] = [];
  const errors: string[] = [];

  while (queue.length > 0 && visited.size < limits.maxPagesPerProvider) {
    const item = queue.shift();
    if (!item || visited.has(item.url.href)) continue;
    visited.add(item.url.href);

    try {
      const content = await fetchAllowedContent(provider, item.url, limits);
      const sourceMetadata = {
        provider: provider.id,
        sourceKind: source.sourceKind,
      };
      const format = provider.responseFormat(item.url);
      const page =
        format === "docc-json"
          ? extractAppleDocCPage(content, item.url.href, sourceMetadata)
          : format === "markdown"
            ? extractMarkdownDocumentationPage(
                content,
                item.url.href,
                provider.platform,
                sourceMetadata,
              )
            : format === "youtrack-json"
              ? extractYouTrackIssue(content, item.url.href, sourceMetadata)
              : extractDocumentationPage(content, item.url.href, provider.platform, sourceMetadata);
      if (page) {
        documents.push(page.document);
        if (item.depth < limits.maxDepth) {
          for (const href of page.links) {
            try {
              const nextUrl = resolveAllowedUrl(provider, href, item.url.href);
              if (!queued.has(nextUrl.href) && !visited.has(nextUrl.href)) {
                queued.add(nextUrl.href);
                queue.push({ url: nextUrl, depth: item.depth + 1 });
              }
            } catch {
              // Off-allowlist and malformed links are intentionally ignored.
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${item.url.href}: ${message}`);
    }

    if (limits.delayMs > 0 && queue.length > 0) {
      await sleep(limits.delayMs);
    }
  }

  return { provider: provider.id, platform: provider.platform, documents, errors };
}

export async function readSourcesConfig(configPath: string): Promise<SourcesConfig> {
  return sourcesConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

export async function updateDocumentationIndex(options: UpdateOptions) {
  const absoluteConfigPath = path.resolve(options.configPath);
  const config = await readSourcesConfig(absoluteConfigPath);
  const selectedPlatforms = new Set(options.platforms ?? PLATFORMS);
  const limits = {
    ...config.crawl,
    ...(options.maxPagesPerProvider ? { maxPagesPerProvider: options.maxPagesPerProvider } : {}),
  };

  const selectedSources = config.sources.filter((source) =>
    selectedPlatforms.has(getProvider(source.provider).platform),
  );
  if (selectedSources.length === 0) {
    throw new Error("No configured sources matched the selected platforms");
  }

  const crawlResults = await Promise.all(
    selectedSources.map((source) => {
      const sourceLimits = {
        ...limits,
        maxPagesPerProvider: Math.min(
          limits.maxPagesPerProvider,
          source.maxPages ?? limits.maxPagesPerProvider,
        ),
        maxDepth: Math.min(limits.maxDepth, source.maxDepth ?? limits.maxDepth),
      };
      return crawlProvider(getProvider(source.provider), source, sourceLimits);
    }),
  );

  const indexedAt = new Date().toISOString();
  const documents = crawlResults.flatMap((result) => result.documents);
  const chunks: IndexedChunk[] = documents.flatMap((document) =>
    chunkDocument(document, indexedAt),
  );
  if (chunks.length === 0) {
    const details = crawlResults
      .flatMap((result) => result.errors)
      .slice(0, 10)
      .join("\n");
    throw new Error(`Index update produced no searchable content${details ? `:\n${details}` : ""}`);
  }

  const outputPath = path.resolve(
    options.outputPath ?? path.resolve(path.dirname(absoluteConfigPath), "..", config.output),
  );
  const index = buildSearchIndex(chunks, documents.length, indexedAt);
  await writeSearchIndex(outputPath, index.serialized);

  return {
    outputPath,
    documentCount: documents.length,
    chunkCount: chunks.length,
    providers: crawlResults.map((result) => ({
      provider: result.provider,
      platform: result.platform,
      documentCount: result.documents.length,
      errors: result.errors,
    })),
  };
}
