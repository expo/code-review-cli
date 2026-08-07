// @ref LLP 0013#direct-url-fetch-boundary [implements] — one caller-supplied page, fixed provider inference, and the same fetch containment as discovery
import type { FetchImplementation } from "./brave-search.js";
import { fetchDocumentationDocument } from "./fetch-document.js";
import { chunkDocument } from "./html.js";
import { getProvider, resolveAllowedUrl } from "./providers.js";
import { buildSearchIndex, searchDocumentation } from "./search-index.js";
import type { ProviderId, SearchResult, SourceKind } from "./types.js";

/** Specific corpora precede their broader host/path parents during URL inference. */
const DIRECT_PROVIDER_ORDER: readonly ProviderId[] = [
  "apple-releases",
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
  "expo",
];

const DIRECT_SOURCE_KIND: Record<ProviderId, SourceKind> = {
  apple: "official-api",
  "apple-releases": "release-notes",
  "swift-evolution": "official-guide",
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
  results: SearchResult[];
}

/** Resolve a caller-supplied URL against the fixed provider allowlist. */
export function resolveDirectDocumentationTarget(
  rawUrl: string,
  providerHint?: ProviderId,
): DirectDocumentationTarget {
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
  let results: SearchResult[];
  if (options.query?.trim()) {
    const index = buildSearchIndex(chunks, 1, indexedAt);
    results = searchDocumentation(index, options.query, {
      platform: document.platform,
      providers: [target.provider],
      limit,
    });
    if (results.length === 0) {
      results = chunks.slice(0, limit).map((chunk) => ({ ...chunk, score: 0 }));
    }
  } else {
    results = chunks.slice(0, limit).map((chunk) => ({ ...chunk, score: 0 }));
  }

  return {
    provider: target.provider,
    sourceKind: target.sourceKind,
    canonicalUrl: target.url.href,
    results,
  };
}
