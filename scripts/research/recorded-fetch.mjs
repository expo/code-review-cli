// Deterministic replay fetch for the research evaluation scripts.
//
// Each evaluation case carries its own fixture (provider, url, title, body).
// This module synthesizes the exact wire responses the MCP expects — Brave
// discovery hits, Expo Algolia hits, the OkHttp static search index, and the
// provider-format document pages (HTML, DocC JSON, Markdown, YouTrack JSON) —
// keyed by the same request URLs the production code computes. The full
// pipeline (query sanitizer, provider routing, allowlists, redirect and
// content-type checks, extraction, chunking, ranking) runs unmodified.
//
// These fixtures validate the retrieval PLUMBING deterministically. They do
// not measure real-world ranking quality; run with RESEARCH_EVAL_LIVE=1 and a
// BRAVE_SEARCH_API_KEY for a live retrieval-quality pass.
import { getProvider, resolveAllowedUrl } from "../../build/research-mcp/providers.js";
import { sanitizeDocumentationQuery } from "../../build/research-mcp/query-sanitizer.js";

const BRAVE_HOST = "api.search.brave.com";
const ALGOLIA_HOST = "qex7pb7d46-dsn.algolia.net";
const OKHTTP_INDEX_URL = "https://lysine.dev/okhttp/search/search_index.json";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body, contentType) {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

/** Remove the fixed `site:` scope expression Brave queries are prefixed with. */
function stripScopeExpression(query) {
  return query
    .replace(/^\((?:site:\S+(?:\s+OR\s+)?)+\)\s+/, "")
    .replace(/^(?:site:\S+\s+)+/, "")
    .trim();
}

function docCDocument(fixture) {
  return {
    metadata: {
      title: fixture.title,
      ...(fixture.availability
        ? {
            platforms: fixture.availability.map((entry) => ({
              name: entry.name,
              introducedAt: entry.introducedAt,
            })),
          }
        : {}),
    },
    abstract: [{ type: "text", text: fixture.body }],
    primaryContentSections: [],
    references: {},
  };
}

function htmlDocument(fixture) {
  return [
    "<!doctype html><html><head><title>",
    fixture.title,
    "</title></head><body><main><h1>",
    fixture.title,
    "</h1><p>",
    fixture.body,
    "</p></main></body></html>",
  ].join("");
}

function youTrackDocument(fixture, canonicalUrl) {
  const issueId = canonicalUrl.pathname.match(/(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:\/|$)/)?.[1] ?? "";
  return {
    idReadable: issueId,
    summary: fixture.title,
    description: fixture.body,
    customFields: [],
    comments: [],
  };
}

/**
 * Build a FetchImplementation that replays the cases' fixtures. Unknown URLs
 * return 404 so an unexpected network dependency fails loudly instead of
 * silently succeeding.
 */
export function createRecordedFetch(cases) {
  const fixtures = cases.filter((entry) => !entry.empty);

  // Precompute each fixture's exact request URL and response format using the
  // SAME provider logic production uses (DocC JSON rewrites, raw-markdown
  // redirect targets, YouTrack API URLs, trailing-slash providers).
  const pages = new Map();
  for (const fixture of fixtures) {
    if (fixture.provider === "expo" || fixture.provider === "okhttp") continue;
    const provider = getProvider(fixture.provider);
    const canonical = resolveAllowedUrl(provider, fixture.url);
    const requestHref = provider.requestUrl(canonical).href;
    const format = provider.responseFormat(canonical);
    const existing = pages.get(requestHref);
    if (existing) {
      // Two cases may target the same document; merge their bodies so both
      // queries find their terms on the shared page.
      existing.body = `${existing.body}\n\n${fixture.body}`;
      continue;
    }
    pages.set(requestHref, {
      title: fixture.title,
      body: fixture.body,
      availability: fixture.availability,
      format,
      canonical,
    });
  }

  const sanitizedQueryOf = (entry) => sanitizeDocumentationQuery(entry.query);

  return async function recordedFetch(input, init) {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );

    if (url.hostname === BRAVE_HOST) {
      const terms = stripScopeExpression(url.searchParams.get("q") ?? "");
      const results = fixtures
        .filter((entry) => sanitizedQueryOf(entry) === terms)
        .map((entry) => ({ title: entry.title, url: entry.url }));
      return jsonResponse({ web: { results } });
    }

    if (url.hostname === ALGOLIA_HOST) {
      const params = new URLSearchParams(JSON.parse(init?.body ?? "{}").params ?? "");
      const query = params.get("query") ?? "";
      const hits = fixtures
        .filter((entry) => entry.provider === "expo" && sanitizedQueryOf(entry) === query)
        .map((entry) => ({
          objectID: entry.url,
          url: entry.url,
          content: `<p>${entry.body}</p>`,
          hierarchy: { lvl0: entry.title },
        }));
      return jsonResponse({ hits });
    }

    if (url.href === OKHTTP_INDEX_URL) {
      const docs = fixtures
        .filter((entry) => entry.provider === "okhttp")
        .map((entry) => ({
          location: entry.url,
          title: entry.title,
          text: `<p>${entry.body}</p>`,
        }));
      return jsonResponse({ docs });
    }

    const page = pages.get(url.href);
    if (!page) {
      return new Response(`no recorded fixture for ${url.href}`, {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
    if (page.format === "docc-json") {
      return jsonResponse(docCDocument(page));
    }
    if (page.format === "youtrack-json") {
      return jsonResponse(youTrackDocument(page, page.canonical));
    }
    if (page.format === "markdown") {
      return textResponse(`# ${page.title}\n\n${page.body}\n`, "text/markdown");
    }
    return textResponse(htmlDocument(page), "text/html");
  };
}
