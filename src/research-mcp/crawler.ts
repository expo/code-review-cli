import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { extractAppleDocCPage } from "./apple-docc.js";
import { fetchAllowedContent } from "./fetch-document.js";
import { chunkDocument, extractDocumentationPage } from "./html.js";
import { extractMarkdownDocumentationPage } from "./markdown.js";
import { getProvider, resolveAllowedUrl, type DocumentationProvider } from "./providers.js";
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

async function crawlProvider(
  provider: DocumentationProvider,
  source: SourceDefinition,
  limits: SourcesConfig["crawl"],
): Promise<CrawlResult> {
  const queue: CrawlItem[] = [];
  const errors: string[] = [];
  for (const seedUrl of source.seedUrls) {
    try {
      queue.push({ url: resolveAllowedUrl(provider, seedUrl), depth: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${seedUrl}: ${message}`);
    }
  }
  const queued = new Set(queue.map((item) => item.url.href));
  const visited = new Set<string>();
  const documents: DiscoveredDocument[] = [];

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

export function resolveIndexOutputPath(
  configPath: string,
  configuredOutput: string,
  outputPath?: string,
): string {
  if (outputPath) return path.resolve(outputPath);
  return path.resolve(path.dirname(path.resolve(configPath)), configuredOutput);
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

  const outputPath = resolveIndexOutputPath(absoluteConfigPath, config.output, options.outputPath);
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
