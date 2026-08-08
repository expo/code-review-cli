// Expo embeds this search-only key in docs.expo.dev's browser client. It cannot
// browse or mutate the index and is not a secret. Expo-provider searches send
// only the already-sanitized API/concept query.
import * as cheerio from "cheerio";
import { z } from "zod";

import type { FetchImplementation } from "./brave-search.js";
import { expoProvider, resolveAllowedUrl } from "./providers.js";
import { readBodyWithLimit } from "./response.js";
import type { DiscoveredDocument } from "./types.js";

const EXPO_ALGOLIA_ENDPOINT = "https://qex7pb7d46-dsn.algolia.net/1/indexes/expo/query";
const EXPO_ALGOLIA_APPLICATION_ID = "QEX7PB7D46";
const EXPO_ALGOLIA_PUBLIC_SEARCH_KEY = "6652d26570e8628af4601e1d78ad456b";
const MAX_HITS = 10;

const hitSchema = z.object({
  objectID: z.string().max(500),
  url: z.string().url().max(2048),
  content: z.string().max(50_000).nullable().optional(),
  language: z.string().max(50).optional(),
  hierarchy: z.record(z.string().max(50), z.string().max(10_000).nullable()).optional(),
});

const responseSchema = z.object({
  hits: z.array(hitSchema).max(MAX_HITS),
});

function text(value: string): string {
  const $ = cheerio.load(`<body>${value}</body>`);
  $("script,style,noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

export function extractExpoAlgoliaDocuments(json: string): DiscoveredDocument[] {
  const response = responseSchema.parse(JSON.parse(json));
  const documents: DiscoveredDocument[] = [];
  const seen = new Set<string>();

  for (const hit of response.hits) {
    const originalUrl = new URL(hit.url);
    const canonicalUrl = resolveAllowedUrl(expoProvider, hit.url);
    canonicalUrl.hash = originalUrl.hash.slice(0, 300);
    const url = canonicalUrl.href;
    const hierarchy = Object.entries(hit.hierarchy ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => (value ? text(value) : ""))
      .filter(Boolean);
    const title = hierarchy.at(-1) ?? hierarchy[0];
    const body = [...hierarchy, hit.content ? text(hit.content) : ""].filter(Boolean).join("\n\n");
    if (!title || body.length < 20 || seen.has(hit.objectID)) continue;
    seen.add(hit.objectID);
    documents.push({
      platform: "react-native",
      provider: "expo",
      sourceKind: "official-api",
      title,
      url,
      body,
    });
  }
  return documents;
}

async function fetchExpoAlgolia(
  query: string,
  limit: number,
  timeoutMs: number,
  maxResponseBytes: number,
  fetchImplementation: FetchImplementation,
): Promise<DiscoveredDocument[]> {
  const response = await fetchImplementation(EXPO_ALGOLIA_ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      "x-algolia-api-key": EXPO_ALGOLIA_PUBLIC_SEARCH_KEY,
      "x-algolia-application-id": EXPO_ALGOLIA_APPLICATION_ID,
    },
    body: JSON.stringify({
      params: new URLSearchParams({
        query,
        hitsPerPage: String(limit),
        page: "0",
      }).toString(),
      facetFilters: [["version:none", "version:latest"]],
      attributesToRetrieve: ["objectID", "url", "content", "hierarchy", "language"],
      attributesToHighlight: [],
    }),
  });
  if (!response.ok) throw new Error(`Expo Algolia returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`Expo Algolia returned unsupported content type: ${contentType || "missing"}`);
  }
  const body = await readBodyWithLimit(response, maxResponseBytes);
  return extractExpoAlgoliaDocuments(body);
}

export async function searchExpoAlgolia(
  query: string,
  limit: number,
  fetchImplementation: FetchImplementation = fetch,
): Promise<DiscoveredDocument[]> {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 300) {
    throw new Error("Expo Algolia query must contain between 1 and 300 characters");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Expo Algolia result limit must be between 1 and 10");
  }
  return fetchExpoAlgolia(normalized, limit, 5000, 1_000_000, fetchImplementation);
}
