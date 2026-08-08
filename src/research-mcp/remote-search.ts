import { createHash } from "node:crypto";

import { searchBrave, type FetchImplementation } from "./brave-search.js";
import { fetchDocumentationDocument } from "./fetch-document.js";
import { chunkDocument } from "./html.js";
import { getProvider, resolveAllowedUrl } from "./providers.js";
import { buildSearchIndex, searchDocumentation } from "./search-index.js";
import type {
  DiscoveredDocument,
  Language,
  ProviderId,
  SearchResult,
  SourceKind,
} from "./types.js";

interface ProviderSearchDefinition {
  scopes: readonly string[];
  sourceKind: SourceKind;
}

const providerSearchDefinitions: Record<Exclude<ProviderId, "expo">, ProviderSearchDefinition> = {
  apple: {
    scopes: ["developer.apple.com/documentation"],
    sourceKind: "official-api",
  },
  "apple-releases": {
    scopes: ["developer.apple.com/documentation/xcode-release-notes"],
    sourceKind: "release-notes",
  },
  "swift-evolution": {
    scopes: ["github.com/swiftlang/swift-evolution/blob/main/proposals"],
    sourceKind: "official-guide",
  },
  sdwebimage: {
    scopes: ["sdwebimage.github.io/documentation/sdwebimage"],
    sourceKind: "official-api",
  },
  android: {
    scopes: ["developer.android.com/reference"],
    sourceKind: "official-api",
  },
  "android-releases": {
    scopes: ["developer.android.com/about/versions"],
    sourceKind: "release-notes",
  },
  media3: {
    scopes: ["developer.android.com"],
    sourceKind: "official-guide",
  },
  glide: {
    scopes: ["bumptech.github.io/glide"],
    sourceKind: "official-guide",
  },
  okhttp: {
    scopes: ["lysine.dev/okhttp"],
    sourceKind: "official-guide",
  },
  "kotlin-coroutines": {
    scopes: ["kotlinlang.org"],
    sourceKind: "official-guide",
  },
  gradle: {
    scopes: ["docs.gradle.org/current"],
    sourceKind: "official-guide",
  },
  agp: {
    scopes: ["developer.android.com"],
    sourceKind: "release-notes",
  },
  "jetbrains-issues": {
    scopes: ["youtrack.jetbrains.com/issue"],
    sourceKind: "issue-tracker",
  },
  "react-native": {
    scopes: ["reactnative.dev"],
    sourceKind: "official-api",
  },
  "react-native-reanimated": {
    scopes: ["docs.swmansion.com/react-native-reanimated/docs"],
    sourceKind: "official-api",
  },
  "react-native-gesture-handler": {
    scopes: ["docs.swmansion.com/react-native-gesture-handler/docs/gestures"],
    sourceKind: "official-api",
  },
  "react-native-screens": {
    scopes: ["docs.swmansion.com"],
    sourceKind: "official-api",
  },
  "react-native-worklets": {
    scopes: ["docs.swmansion.com/react-native-worklets/docs"],
    sourceKind: "official-api",
  },
};

export interface RemoteSearchOptions {
  apiKey: string;
  fetchImplementation?: FetchImplementation;
  language?: Language;
  sourceKinds?: SourceKind[];
  /**
   * The call deadline. The wrapped fetch already fails once it passes, but the
   * candidate walk below should stop and return what it has rather than march
   * through every remaining candidate collecting identical timeout warnings.
   */
  deadline?: AbortSignal;
}

export interface RemoteSearchResponse {
  results: SearchResult[];
  warnings: string[];
}

function appleReleaseScopes(query: string): readonly string[] {
  if (/\b(?:ios|ipados)\b/i.test(query)) {
    return ["developer.apple.com/documentation/ios-ipados-release-notes"];
  }
  if (/\bmacos\b/i.test(query)) {
    return ["developer.apple.com/documentation/macos-release-notes"];
  }
  if (/\btvos\b/i.test(query)) {
    return ["developer.apple.com/documentation/tvos-release-notes"];
  }
  if (/\bwatchos\b/i.test(query)) {
    return ["developer.apple.com/documentation/watchos-release-notes"];
  }
  if (/\bvisionos\b/i.test(query)) {
    return ["developer.apple.com/documentation/visionos-release-notes"];
  }
  return providerSearchDefinitions["apple-releases"].scopes;
}

function bestPassage(
  document: DiscoveredDocument,
  query: string,
  indexedAt: string,
): { passage: string; relevance: number } {
  const chunks = chunkDocument(document, indexedAt);
  if (chunks.length === 0) {
    return { passage: document.body.slice(0, 1_400), relevance: 0 };
  }
  const index = buildSearchIndex(chunks, 1, indexedAt);
  const result = searchDocumentation(index, query, {
    platform: document.platform,
    providers: document.provider ? [document.provider] : undefined,
    limit: 1,
  })[0];
  return {
    passage: result?.passage ?? chunks[0]!.passage,
    relevance: result?.score ?? 0,
  };
}

export async function searchRemoteDocumentation(
  providerId: Exclude<ProviderId, "expo">,
  query: string,
  limit: number,
  options: RemoteSearchOptions,
): Promise<RemoteSearchResponse> {
  const definition = providerSearchDefinitions[providerId];
  if (options.sourceKinds && !options.sourceKinds.includes(definition.sourceKind)) {
    return { results: [], warnings: [] };
  }
  const provider = getProvider(providerId);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const hits = await searchBrave(
    query,
    providerId === "apple-releases" ? appleReleaseScopes(query) : definition.scopes,
    Math.min(10, Math.max(limit * 2, 4)),
    options.apiKey,
    fetchImplementation,
  );

  const candidates: Array<{ url: URL; position: number }> = [];
  const seen = new Set<string>();
  for (const [position, hit] of hits.entries()) {
    try {
      const url = resolveAllowedUrl(provider, hit.url);
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      candidates.push({ url, position });
    } catch {
      // Search ranking is discovery only. The provider allowlist is authoritative.
    }
  }

  const warnings: string[] = [];
  const indexedAt = new Date().toISOString();
  const fetchCandidate = async ({
    url,
    position,
  }: {
    url: URL;
    position: number;
  }): Promise<SearchResult | null> => {
    try {
      const document = await fetchDocumentationDocument(
        provider,
        url.href,
        definition.sourceKind,
        fetchImplementation,
      );
      if (!document || (options.language && document.language !== options.language)) return null;
      const id = createHash("sha256")
        .update(`${providerId}\0${document.url}\0${document.title}`)
        .digest("hex")
        .slice(0, 16);
      const selected = bestPassage(document, query, indexedAt);
      const result: SearchResult = {
        id: `remote:${providerId}:${id}`,
        platform: document.platform,
        provider: providerId,
        sourceKind: definition.sourceKind,
        title: document.title,
        url: document.url,
        passage: selected.passage,
        ...(document.framework ? { framework: document.framework } : {}),
        ...(document.symbol ? { symbol: document.symbol } : {}),
        ...(document.language ? { language: document.language } : {}),
        ...(document.availability ? { availability: document.availability } : {}),
        indexedAt,
        score: selected.relevance * 100 + hits.length - position,
      };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${provider.displayName} fetch failed for ${url.href}: ${message}`);
      return null;
    }
  };

  // Brave ranking is discovery order. Fetch only enough pages to satisfy the
  // caller, advancing to later candidates when a page is rejected or unavailable.
  // Batching the outstanding result count preserves parallelism without eagerly
  // downloading every discovery candidate.
  const fetched: SearchResult[] = [];
  let candidateIndex = 0;
  while (
    fetched.length < limit &&
    candidateIndex < candidates.length &&
    !options.deadline?.aborted
  ) {
    const outstanding = limit - fetched.length;
    const batch = candidates.slice(candidateIndex, candidateIndex + outstanding);
    candidateIndex += batch.length;
    const batchResults = await Promise.all(batch.map(fetchCandidate));
    fetched.push(...batchResults.flatMap((result) => (result ? [result] : [])));
  }

  return {
    results: fetched.sort((left, right) => right.score - left.score).slice(0, limit),
    warnings: warnings.slice(0, 5),
  };
}
