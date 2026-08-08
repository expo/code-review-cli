import { expect, test } from "bun:test";

import {
  createResearchNetwork,
  ResearchDeadlineError,
  totalResearchNetwork,
} from "../../research-mcp/network.js";
import { fetchDocumentationUrl } from "../../research-mcp/direct-fetch.js";

const html =
  "<html><head><title>Doc</title></head><body><main><h1>Doc</h1>" +
  "<p>CameraView barcodeScannerSettings documentation body text.</p></main></body></html>";

function page(): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

test("the call deadline bounds a redirect chain that the per-hop timeout cannot", async () => {
  // Every hop answers quickly enough to beat the hardcoded 10s per-attempt limit,
  // which is exactly how a chain reaches 60s with no end-to-end bound.
  const network = createResearchNetwork(async (input) => {
    const url = new URL(typeof input === "string" ? input : ((input as URL).href ?? String(input)));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const next = new URL(url.href);
    next.pathname += "/hop";
    return new Response(null, { status: 302, headers: { location: next.href } });
  }, 200);

  await expect(
    fetchDocumentationUrl("https://docs.expo.dev/versions/latest/sdk/camera", {
      fetchImplementation: network.fetch,
    }),
  ).rejects.toThrow();
  expect(network.expired()).toBe(true);
  // Without the deadline this walks all six hops; the deadline cuts it short.
  expect(network.counts().totalRequests).toBeLessThan(6);
});

test("an expired deadline refuses the next request instead of starting it", async () => {
  let issued = 0;
  const network = createResearchNetwork(async () => {
    issued++;
    return page();
  }, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  await expect(network.fetch("https://docs.expo.dev/x")).rejects.toBeInstanceOf(
    ResearchDeadlineError,
  );
  expect(issued).toBe(0);
});

test("the ledger separates paid discovery from page fetches and redirect hops", async () => {
  const network = createResearchNetwork(async (input) => {
    const href = typeof input === "string" ? input : ((input as URL).href ?? String(input));
    if (href.startsWith("https://api.search.brave.com/")) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.endsWith("/redirect-me")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://docs.expo.dev/final" },
      });
    }
    return page();
  }, 10_000);

  await network.fetch("https://api.search.brave.com/res/v1/web/search?q=x");
  await network.fetch("https://docs.expo.dev/redirect-me");
  await network.fetch("https://docs.expo.dev/final");

  expect(network.counts()).toMatchObject({
    searchRequests: 1,
    // The redirect hop is a round trip, not a distinct page.
    documentRequests: 1,
    redirects: 1,
    totalRequests: 3,
  });
});

test("per-call ledgers sum into one review-wide total", () => {
  expect(
    totalResearchNetwork([
      {
        searchRequests: 4,
        documentRequests: 16,
        redirects: 2,
        totalRequests: 22,
        elapsedMs: 1_200,
      },
      { searchRequests: 1, documentRequests: 3, redirects: 0, totalRequests: 4, elapsedMs: 300 },
    ]),
  ).toEqual({
    searchRequests: 5,
    documentRequests: 19,
    redirects: 2,
    totalRequests: 26,
    elapsedMs: 1_500,
  });
});
