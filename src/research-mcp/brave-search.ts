import { z } from "zod";

import { readBodyWithLimit } from "./response.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_RESPONSE_LIMIT_BYTES = 1_000_000;
const BRAVE_TIMEOUT_MS = 10_000;

const braveResponseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().min(1).max(500),
            url: z.string().url().max(2_000),
            description: z.string().max(2_000).optional(),
          }),
        )
        .max(50),
    })
    .optional(),
});

export interface BraveSearchHit {
  title: string;
  url: string;
  description?: string;
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function normalizeSearchText(value: string): string {
  return (
    value
      // oxlint-disable-next-line no-control-regex -- outbound query sanitization
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function buildScopedSearchQuery(query: string, scopes: readonly string[]): string {
  const normalized = normalizeSearchText(query);
  if (!normalized || normalized.length > 300) {
    throw new Error("Query must contain between 1 and 300 visible characters");
  }
  if (scopes.length === 0 || scopes.length > 8) {
    throw new Error("A documentation search requires between 1 and 8 fixed scopes");
  }
  const scopeExpression =
    scopes.length === 1
      ? `site:${scopes[0]}`
      : `(${scopes.map((scope) => `site:${scope}`).join(" OR ")})`;
  const scopedQuery = `${scopeExpression} ${normalized}`;
  if (scopedQuery.length > 400 || scopedQuery.split(/\s+/).length > 50) {
    throw new Error("Scoped query exceeds Brave Search limits");
  }
  return scopedQuery;
}

export async function searchBrave(
  query: string,
  scopes: readonly string[],
  limit: number,
  apiKey: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<BraveSearchHit[]> {
  if (!apiKey.trim()) {
    throw new Error("BRAVE_SEARCH_API_KEY is not set");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Search result limit must be between 1 and 10");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", buildScopedSearchQuery(query, scopes));
  url.searchParams.set("count", String(limit));
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("safesearch", "moderate");

  const response = await fetchImplementation(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(BRAVE_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "accept-encoding": "gzip",
      "x-subscription-token": apiKey,
      "user-agent": "review-research-mcp/0.2 (+scoped documentation search)",
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Brave Search unexpectedly redirected with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`Brave Search returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Brave Search returned unsupported content type: ${contentType || "missing"}`);
  }

  const parsed = braveResponseSchema.parse(
    JSON.parse(await readBodyWithLimit(response, BRAVE_RESPONSE_LIMIT_BYTES)),
  );
  return parsed.web?.results ?? [];
}
