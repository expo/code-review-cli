import { extractAppleDocCPage } from "./apple-docc.js";
import { extractDocumentationPage } from "./html.js";
import { extractMarkdownDocumentationPage } from "./markdown.js";
import {
  resolveAllowedRequestUrl,
  resolveAllowedUrl,
  type DocumentationProvider,
} from "./providers.js";
import { readBodyWithLimit } from "./response.js";
import type { DiscoveredDocument, ProviderId, SourceKind, SourcesConfig } from "./types.js";
import { extractYouTrackIssue } from "./youtrack.js";
import type { FetchImplementation } from "./brave-search.js";

export const onDemandFetchLimits: SourcesConfig["crawl"] = {
  maxPagesPerProvider: 10,
  maxDepth: 0,
  delayMs: 0,
  timeoutMs: 10_000,
  maxResponseBytes: 5_000_000,
};

export async function fetchAllowedContent(
  provider: DocumentationProvider,
  documentUrl: URL,
  limits: Pick<SourcesConfig["crawl"], "timeoutMs" | "maxResponseBytes">,
  fetchImplementation: FetchImplementation = fetch,
): Promise<string> {
  let currentUrl = resolveAllowedRequestUrl(provider, provider.requestUrl(documentUrl).href);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetchImplementation(currentUrl, {
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
        "user-agent": "review-research-mcp/0.2 (+on-demand official documentation fetcher)",
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

export async function fetchDocumentationDocument(
  provider: DocumentationProvider,
  rawUrl: string,
  sourceKind: SourceKind,
  fetchImplementation: FetchImplementation = fetch,
): Promise<DiscoveredDocument | null> {
  const documentUrl = resolveAllowedUrl(provider, rawUrl);
  const content = await fetchAllowedContent(
    provider,
    documentUrl,
    onDemandFetchLimits,
    fetchImplementation,
  );
  const source = {
    provider: provider.id as ProviderId,
    sourceKind,
  };
  const format = provider.responseFormat(documentUrl);
  const extracted =
    format === "docc-json"
      ? extractAppleDocCPage(content, documentUrl.href, source)
      : format === "markdown"
        ? extractMarkdownDocumentationPage(content, documentUrl.href, provider.platform, source)
        : format === "youtrack-json"
          ? extractYouTrackIssue(content, documentUrl.href, source)
          : extractDocumentationPage(content, documentUrl.href, provider.platform, source);
  return extracted?.document ?? null;
}
