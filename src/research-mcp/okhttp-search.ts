import { z } from "zod";

import type { FetchImplementation } from "./brave-search.js";
import { chunkDocument, extractDocumentationPage } from "./html.js";
import { okHttpProvider, resolveAllowedUrl } from "./providers.js";
import { readBodyWithLimit } from "./response.js";
import { buildSearchIndex, searchDocumentation, type BuiltSearchIndex } from "./search-index.js";
import type { SearchResult } from "./types.js";

const OKHTTP_SEARCH_INDEX = "https://lysine.dev/okhttp/search/search_index.json";
const OKHTTP_SEARCH_INDEX_LIMIT_BYTES = 1_000_000;
const OKHTTP_SEARCH_TIMEOUT_MS = 10_000;

const okHttpSearchIndexSchema = z.object({
  docs: z
    .array(
      z.object({
        location: z.string().max(2_000),
        title: z.string().min(1).max(500),
        text: z.string().max(100_000),
      }),
    )
    .max(1_000),
});

const indexCache = new WeakMap<FetchImplementation, Promise<BuiltSearchIndex>>();

async function loadOkHttpSearchIndex(
  fetchImplementation: FetchImplementation,
): Promise<BuiltSearchIndex> {
  const response = await fetchImplementation(OKHTTP_SEARCH_INDEX, {
    redirect: "manual",
    signal: AbortSignal.timeout(OKHTTP_SEARCH_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "review-research-mcp/0.2 (+official documentation search index)",
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`OkHttp search index unexpectedly redirected with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`OkHttp search index returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `OkHttp search index returned unsupported content type: ${contentType || "missing"}`,
    );
  }

  const parsed = okHttpSearchIndexSchema.parse(
    JSON.parse(await readBodyWithLimit(response, OKHTTP_SEARCH_INDEX_LIMIT_BYTES)),
  );
  const indexedAt = new Date().toISOString();
  const seenDocuments = new Set<string>();
  const documents = parsed.docs.flatMap((entry) => {
    try {
      const url = resolveAllowedUrl(okHttpProvider, entry.location, "https://lysine.dev/okhttp/");
      const key = `${url.href}|${entry.title}`;
      if (seenDocuments.has(key)) return [];
      seenDocuments.add(key);
      const extracted = extractDocumentationPage(
        `<!doctype html><html><body><main><h1>${entry.title}</h1>${entry.text}</main></body></html>`,
        url.href,
        "android",
        { provider: "okhttp", sourceKind: "official-guide" },
      );
      return extracted ? [extracted.document] : [];
    } catch {
      return [];
    }
  });
  const chunks = documents.flatMap((document) => chunkDocument(document, indexedAt));
  return buildSearchIndex(chunks);
}

function cachedOkHttpSearchIndex(
  fetchImplementation: FetchImplementation,
): Promise<BuiltSearchIndex> {
  const cached = indexCache.get(fetchImplementation);
  if (cached) return cached;
  const pending = loadOkHttpSearchIndex(fetchImplementation);
  indexCache.set(fetchImplementation, pending);
  return pending;
}

export async function searchOkHttpDocumentation(
  query: string,
  limit: number,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SearchResult[]> {
  const index = await cachedOkHttpSearchIndex(fetchImplementation);
  const search = (value: string) =>
    searchDocumentation(index, value, {
      platform: "android",
      providers: ["okhttp"],
      sourceKinds: ["official-guide"],
      limit,
    });
  const conceptTokens = [...new Set(query.match(/\b[a-z][a-z0-9-]{3,}\b/g) ?? [])];
  const concepts = conceptTokens.join(" ");
  const candidates =
    concepts && concepts !== query
      ? [
          ...conceptTokens.flatMap((concept) => search(concept).slice(0, 1)),
          ...search(concepts),
          ...search(query),
        ]
      : search(query);
  const seen = new Set<string>();
  return candidates
    .filter((result) => {
      const key = `${result.url}|${result.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
