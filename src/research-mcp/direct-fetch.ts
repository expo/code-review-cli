// @ref LLP 0013#direct-url-fetch-boundary [implements] — one caller-supplied page, fixed provider inference, and the same fetch containment as discovery
import type { FetchImplementation } from "./brave-search.js";
import { fetchDocumentationDocument } from "./fetch-document.js";
import { chunkDocument } from "./html.js";
import { getProvider, resolveAllowedUrl } from "./providers.js";
import { assertSafeDocumentationUrlShape } from "./query-sanitizer.js";
import { buildSearchIndex, searchDocumentation } from "./search-index.js";
import type {
  DiscoveredDocument,
  IndexedChunk,
  ProviderId,
  SearchResult,
  SourceKind,
} from "./types.js";

/** Specific corpora precede their broader host/path parents during URL inference. */
const DIRECT_PROVIDER_ORDER: readonly ProviderId[] = [
  "apple-releases",
  "sdwebimage",
  "apple",
  "swift-evolution",
  "android-releases",
  "media3",
  "agp",
  "android",
  "glide",
  "okhttp",
  "kotlin-coroutines",
  "gradle",
  "jetbrains-issues",
  "react-native-reanimated",
  "react-native-gesture-handler",
  "react-native-screens",
  "react-native-worklets",
  "react-native",
  "metro",
  "expo",
];

const DIRECT_SOURCE_KIND: Record<ProviderId, SourceKind> = {
  apple: "official-api",
  "apple-releases": "release-notes",
  "swift-evolution": "official-guide",
  sdwebimage: "official-api",
  android: "official-api",
  "android-releases": "release-notes",
  media3: "official-guide",
  glide: "official-guide",
  okhttp: "official-guide",
  "kotlin-coroutines": "official-guide",
  gradle: "official-guide",
  agp: "release-notes",
  "jetbrains-issues": "issue-tracker",
  expo: "official-api",
  "react-native": "official-api",
  "react-native-reanimated": "official-guide",
  "react-native-gesture-handler": "official-guide",
  "react-native-screens": "official-guide",
  "react-native-worklets": "official-guide",
  metro: "official-guide",
};

export interface DirectDocumentationTarget {
  provider: ProviderId;
  sourceKind: SourceKind;
  url: URL;
}

export interface DirectDocumentationFetch {
  provider: ProviderId;
  sourceKind: SourceKind;
  canonicalUrl: string;
  context: DirectDocumentationContext;
  results: SearchResult[];
}

export const DIRECT_DOCUMENT_CONTEXT_MODES = ["focused", "section", "document"] as const;
export type DirectDocumentContextMode = (typeof DIRECT_DOCUMENT_CONTEXT_MODES)[number];

export interface DirectDocumentationContext {
  mode: DirectDocumentContextMode;
  returnedCharacters: number;
  documentCharacters: number;
  truncated: boolean;
  anchorPassageId?: string;
  availablePassageCount: number;
  availablePassageIds: string[];
  passageIdsTruncated?: boolean;
}

const SECTION_CONTEXT_CHARACTERS = 12_000;
const DOCUMENT_CONTEXT_CHARACTERS = 20_000;

function withScore(chunk: IndexedChunk, score = 0): SearchResult {
  return { ...chunk, score };
}

function rankedAnchor(
  chunks: IndexedChunk[],
  document: DiscoveredDocument,
  provider: ProviderId,
  query?: string,
): SearchResult | undefined {
  if (!query?.trim()) return chunks[0] ? withScore(chunks[0]) : undefined;
  const index = buildSearchIndex(chunks);
  return (
    searchDocumentation(index, query, {
      platform: document.platform,
      providers: [provider],
      limit: 1,
    })[0] ?? (chunks[0] ? withScore(chunks[0]) : undefined)
  );
}

function contiguousWindow(body: string, anchor: string, maxCharacters: number): string {
  if (body.length <= maxCharacters) return body;
  const exactIndex = body.indexOf(anchor);
  const prefixIndex = exactIndex >= 0 ? exactIndex : body.indexOf(anchor.slice(0, 160));
  const anchorIndex = prefixIndex >= 0 ? prefixIndex : 0;
  const centeredStart = Math.max(0, anchorIndex - Math.floor(maxCharacters / 3));
  let start = centeredStart;
  const previousBoundary = body.lastIndexOf("\n\n", centeredStart);
  if (previousBoundary >= Math.max(0, centeredStart - 300)) start = previousBoundary + 2;
  let end = Math.min(body.length, start + maxCharacters);
  const nextBoundary = body.indexOf("\n\n", end - 300);
  if (nextBoundary >= 0 && nextBoundary <= start + maxCharacters) end = nextBoundary;
  return body.slice(start, end).trim();
}

function focusedResults(
  chunks: IndexedChunk[],
  anchor: SearchResult | undefined,
  limit: number,
): SearchResult[] {
  if (!anchor) return [];
  const anchorIndex = Math.max(
    0,
    chunks.findIndex((chunk) => chunk.id === anchor.id),
  );
  const start = Math.max(0, Math.min(anchorIndex - Math.floor(limit / 2), chunks.length - limit));
  return chunks
    .slice(start, start + limit)
    .map((chunk) => withScore(chunk, chunk.id === anchor.id ? anchor.score : 0));
}

/** Resolve a caller-supplied URL against the fixed provider allowlist. */
export function resolveDirectDocumentationTarget(
  rawUrl: string,
  providerHint?: ProviderId,
): DirectDocumentationTarget {
  assertSafeDocumentationUrlShape(rawUrl);
  const candidates = providerHint ? [providerHint] : DIRECT_PROVIDER_ORDER;
  for (const providerId of candidates) {
    const provider = getProvider(providerId);
    try {
      return {
        provider: providerId,
        sourceKind: DIRECT_SOURCE_KIND[providerId],
        url: resolveAllowedUrl(provider, rawUrl),
      };
    } catch {
      // Try the next fixed provider. No caller-controlled host is ever admitted.
    }
  }
  throw new Error(
    providerHint
      ? `URL is outside the ${providerHint} documentation allowlist`
      : "URL is outside the supported documentation allowlist",
  );
}

/** Fetch one allowlisted documentation URL and return bounded extracted passages. */
export async function fetchDocumentationUrl(
  rawUrl: string,
  options: {
    provider?: ProviderId;
    query?: string;
    limit?: number;
    context?: DirectDocumentContextMode;
    fetchImplementation?: FetchImplementation;
  } = {},
): Promise<DirectDocumentationFetch> {
  const target = resolveDirectDocumentationTarget(rawUrl, options.provider);
  const provider = getProvider(target.provider);
  const document = await fetchDocumentationDocument(
    provider,
    target.url.href,
    target.sourceKind,
    options.fetchImplementation ?? fetch,
  );
  if (!document) {
    throw new Error(`No readable documentation content at ${target.url.href}`);
  }

  const indexedAt = new Date().toISOString();
  const chunks = chunkDocument(document, indexedAt);
  const limit = Math.min(5, Math.max(1, options.limit ?? 3));
  const mode = options.context ?? "section";
  const anchor = rankedAnchor(chunks, document, target.provider, options.query);
  let results: SearchResult[] = [];
  if (mode === "focused") {
    results = focusedResults(chunks, anchor, limit);
  } else if (anchor) {
    const maxCharacters =
      mode === "document" ? DOCUMENT_CONTEXT_CHARACTERS : SECTION_CONTEXT_CHARACTERS;
    const passage =
      mode === "document"
        ? document.body.slice(0, maxCharacters).trim()
        : contiguousWindow(document.body, anchor.passage, maxCharacters);
    const {
      previousPassageId: _previous,
      nextPassageId: _next,
      ...anchorWithoutNeighbors
    } = anchor;
    results = [
      {
        ...anchorWithoutNeighbors,
        id: `${anchor.id.replace(/#\d+$/, "")}#${mode}`,
        passage,
      },
    ];
  }
  const returnedCharacters = results.reduce((total, result) => total + result.passage.length, 0);

  return {
    provider: target.provider,
    sourceKind: target.sourceKind,
    canonicalUrl: target.url.href,
    context: {
      mode,
      returnedCharacters,
      documentCharacters: document.body.length,
      truncated: returnedCharacters < document.body.length,
      ...(anchor ? { anchorPassageId: anchor.id } : {}),
      availablePassageCount: chunks.length,
      availablePassageIds: chunks.slice(0, 100).map((chunk) => chunk.id),
      ...(chunks.length > 100 ? { passageIdsTruncated: true } : {}),
    },
    results,
  };
}
