// @ref LLP 0013#search-fetch-and-optional-index-boundary [implements] — one per-call deadline and one request ledger for every outbound request
/**
 * The outbound seam for a single MCP tool call: one deadline and one ledger,
 * wrapped around the fetch implementation every search and fetch path already
 * receives.
 *
 * Two problems made this necessary, and both are structural rather than
 * incidental:
 *
 *  - No engine can bound a call's duration. OpenCode's `mcp.timeout` bounds tool
 *    DISCOVERY, not execution, and Claude passes no per-call timeout at all. The
 *    only hardcoded bound was 10s PER REDIRECT HOP, which multiplies: a page that
 *    redirects five times costs 60s, and a four-provider search walking its
 *    candidates costs minutes. The deadline has to live here.
 *  - The audit reserved one budget unit per tool call and reported nothing about
 *    what that unit spent. One call can issue four paid searches and sixteen page
 *    downloads, so "8 calls" understated real traffic by more than an order of
 *    magnitude.
 *
 * Wrapping fetch (rather than threading a signal through every signature) means
 * every existing caller is covered automatically, including paths added later.
 */
import type { FetchImplementation } from "./brave-search.js";

/** Discovery endpoints. Everything else is a documentation page or asset. */
const SEARCH_ENDPOINTS = [
  "https://api.search.brave.com/",
  "https://qex7pb7d46-dsn.algolia.net/",
  "https://lysine.dev/okhttp/search/search_index.json",
];

export interface ResearchNetworkCounts {
  /** Discovery requests, i.e. the ones that cost search-provider quota. */
  searchRequests: number;
  /** Documentation page and asset requests, excluding redirect hops. */
  documentRequests: number;
  /** Redirect responses followed. Each one is an extra round trip. */
  redirects: number;
  /** Every HTTP request actually issued, redirect hops included. */
  totalRequests: number;
  elapsedMs: number;
}

export class ResearchDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Documentation research call exceeded its ${timeoutMs}ms deadline`);
    this.name = "ResearchDeadlineError";
  }
}

export interface ResearchNetwork {
  /** Drop-in replacement for the caller's fetch: deadline-bound and counted. */
  fetch: FetchImplementation;
  /** The call deadline, for loops that should stop rather than fail per-item. */
  signal: AbortSignal;
  expired(): boolean;
  counts(): ResearchNetworkCounts;
}

export function createResearchNetwork(
  base: FetchImplementation,
  timeoutMs: number,
): ResearchNetwork {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ResearchDeadlineError(timeoutMs)), timeoutMs);
  // The MCP is a short-lived stdio process; never hold the loop open for this.
  timer.unref?.();

  let searchRequests = 0;
  let documentRequests = 0;
  let redirects = 0;
  let totalRequests = 0;

  const wrapped: FetchImplementation = async (input, init) => {
    if (controller.signal.aborted) throw new ResearchDeadlineError(timeoutMs);

    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    totalRequests++;
    if (SEARCH_ENDPOINTS.some((endpoint) => href.startsWith(endpoint))) searchRequests++;
    else documentRequests++;

    // Keep the caller's own per-attempt timeout AND add the call deadline, so a
    // single slow hop still fails fast while the whole call stays bounded.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;

    const response = await base(input, { ...init, signal });
    if (response.status >= 300 && response.status < 400) {
      redirects++;
      // A redirect hop is a round trip, not a new document; undo the document
      // count so `documentRequests` stays a count of distinct pages requested.
      documentRequests--;
    }
    return response;
  };

  return {
    fetch: wrapped,
    signal: controller.signal,
    expired: () => controller.signal.aborted,
    counts: () => ({
      searchRequests,
      documentRequests,
      redirects,
      totalRequests,
      elapsedMs: Date.now() - startedAt,
    }),
  };
}

/** Sum per-call ledgers into one review-wide total. */
export function totalResearchNetwork(
  counts: readonly ResearchNetworkCounts[],
): ResearchNetworkCounts {
  return counts.reduce<ResearchNetworkCounts>(
    (total, entry) => ({
      searchRequests: total.searchRequests + entry.searchRequests,
      documentRequests: total.documentRequests + entry.documentRequests,
      redirects: total.redirects + entry.redirects,
      totalRequests: total.totalRequests + entry.totalRequests,
      elapsedMs: total.elapsedMs + entry.elapsedMs,
    }),
    { searchRequests: 0, documentRequests: 0, redirects: 0, totalRequests: 0, elapsedMs: 0 },
  );
}
