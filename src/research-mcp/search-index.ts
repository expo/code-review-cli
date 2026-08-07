import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import MiniSearch, { type SearchOptions } from "minisearch";

import type {
  IndexedChunk,
  Language,
  Platform,
  PlatformFilter,
  ProviderId,
  SearchResult,
  SerializedSearchIndex,
  SourceKind,
} from "./types.js";

const miniSearchOptions = {
  fields: ["title", "passage", "framework", "symbol", "provider"],
  storeFields: [
    "id",
    "platform",
    "provider",
    "sourceKind",
    "title",
    "url",
    "passage",
    "framework",
    "symbol",
    "language",
    "availability",
    "indexedAt",
  ],
};

export interface BuiltSearchIndex {
  serialized: SerializedSearchIndex;
  miniSearch: MiniSearch<IndexedChunk>;
}

export function buildSearchIndex(
  chunks: IndexedChunk[],
  documentCount: number,
  generatedAt = new Date().toISOString(),
): BuiltSearchIndex {
  const miniSearch = new MiniSearch<IndexedChunk>(miniSearchOptions);
  miniSearch.addAll(chunks);

  const providers = [
    ...new Set(chunks.map((chunk) => chunk.provider ?? chunk.platform)),
  ].sort() as ProviderId[];
  return {
    miniSearch,
    serialized: {
      schemaVersion: 1,
      generatedAt,
      documentCount,
      chunkCount: chunks.length,
      providers,
      searchIndex: miniSearch.toJSON(),
    },
  };
}

export async function writeSearchIndex(filePath: string, index: SerializedSearchIndex) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(index)}\n`, { mode: 0o644 });
  await rename(temporaryPath, filePath);
}

export async function loadSearchIndex(filePath: string): Promise<BuiltSearchIndex> {
  const serialized = JSON.parse(await readFile(filePath, "utf8")) as SerializedSearchIndex;
  if (serialized.schemaVersion !== 1 || typeof serialized.searchIndex !== "object") {
    throw new Error(`Unsupported or invalid search index at ${filePath}`);
  }
  const miniSearch = MiniSearch.loadJSON<IndexedChunk>(
    JSON.stringify(serialized.searchIndex),
    miniSearchOptions,
  );
  return { serialized, miniSearch };
}

function searchOptions(combineWith: "AND" | "OR", exact = false): SearchOptions {
  return {
    boost: { title: 4, symbol: 5, framework: 2, passage: 1 },
    combineWith,
    prefix: !exact,
    fuzzy: exact ? false : (term) => (term.length >= 8 ? 0.12 : false),
  };
}

function identifierAnchors(query: string): string[] {
  return (query.match(/[A-Za-z0-9_.$]+/g) ?? [])
    .filter((term) => {
      if (/^[A-Z0-9_]+$/.test(term)) {
        return term.length >= 4;
      }
      return /[._]/.test(term) || /[A-Z]/.test(term.slice(1));
    })
    .map((term) => term.toLowerCase());
}

function identityContainsAnchor(identity: string, anchor: string): boolean {
  const escaped = anchor.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(identity);
}

export function searchDocumentation(
  index: BuiltSearchIndex,
  query: string,
  options: {
    platform: PlatformFilter;
    providers?: ProviderId[];
    sourceKinds?: SourceKind[];
    language?: Language;
    limit: number;
  },
): SearchResult[] {
  const normalizedQuery = query
    // oxlint-disable-next-line no-control-regex -- intentional untrusted-query sanitization
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedQuery || normalizedQuery.length > 300) {
    throw new Error("Query must contain between 1 and 300 visible characters");
  }

  const filter = (result: Record<string, unknown>) =>
    (options.platform === "all" || result.platform === options.platform) &&
    (!options.providers || options.providers.includes(result.provider as ProviderId)) &&
    (!options.sourceKinds || options.sourceKinds.includes(result.sourceKind as SourceKind)) &&
    (!options.language || result.language === options.language);

  const anchors = identifierAnchors(normalizedQuery);
  let matches = index.miniSearch.search(normalizedQuery, {
    ...searchOptions("AND", anchors.length > 0),
    filter,
  });
  if (matches.length === 0) {
    matches = index.miniSearch.search(normalizedQuery, {
      ...searchOptions("OR", anchors.length > 0),
      filter,
    });
    if (anchors.length > 0) {
      matches = matches.filter((match) => {
        const identity = [match.title, match.symbol, match.url]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase();
        return anchors.some((anchor) => identityContainsAnchor(identity, anchor));
      });
    }
  }

  const seenDocuments = new Set<string>();
  const uniqueMatches = matches.filter((match) => {
    const key = `${String(match.provider)}|${String(match.url)}|${String(match.title)}`;
    if (seenDocuments.has(key)) return false;
    seenDocuments.add(key);
    return true;
  });

  return uniqueMatches.slice(0, options.limit).map((match) => ({
    id: String(match.id),
    platform: match.platform as Platform,
    provider: (match.provider ?? match.platform) as ProviderId,
    sourceKind: (match.sourceKind ?? "official-api") as SourceKind,
    title: String(match.title),
    url: String(match.url),
    passage: String(match.passage),
    ...(match.framework ? { framework: String(match.framework) } : {}),
    ...(match.symbol ? { symbol: String(match.symbol) } : {}),
    ...(match.language ? { language: match.language as Language } : {}),
    ...(Array.isArray(match.availability) ? { availability: match.availability.map(String) } : {}),
    indexedAt: String(match.indexedAt),
    score: match.score,
  }));
}
