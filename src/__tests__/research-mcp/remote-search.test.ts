import { expect, test } from "bun:test";

import { buildScopedSearchQuery } from "../../research-mcp/brave-search.js";
import { searchRemoteDocumentation } from "../../research-mcp/remote-search.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

test("scoped search rejects prose bounds before making a request", () => {
  expect(() => buildScopedSearchQuery("", ["developer.apple.com/documentation"])).toThrow(
    /between 1 and 300/,
  );
  expect(() =>
    buildScopedSearchQuery("MainActor", [
      "one.example",
      "two.example",
      "three.example",
      "four.example",
      "five.example",
      "six.example",
      "seven.example",
      "eight.example",
      "nine.example",
    ]),
  ).toThrow(/between 1 and 8/);
});

test("Apple discovery searches Brave once, rejects foreign results, and fetches DocC JSON", async () => {
  let searchRequests = 0;
  let documentRequests = 0;
  const fetchImplementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.search.brave.com") {
      searchRequests++;
      expect(init?.headers).toMatchObject({ "x-subscription-token": "test-key" });
      expect(url.searchParams.get("q") ?? "").toContain("site:developer.apple.com/documentation");
      expect(url.searchParams.get("q") ?? "").toContain("AVAudioSession setActive");
      return jsonResponse({
        web: {
          results: [
            {
              title: "AVAudioSession",
              url: "https://developer.apple.com/documentation/avfaudio/avaudiosession",
            },
            {
              title: "Forged mirror",
              url: "https://attacker.example/documentation/avfaudio/avaudiosession",
            },
          ],
        },
      });
    }
    documentRequests++;
    expect(url.href).toBe(
      "https://developer.apple.com/tutorials/data/documentation/avfaudio/avaudiosession.json",
    );
    return jsonResponse({
      metadata: {
        title: "AVAudioSession",
        role: "symbol",
        modules: [{ name: "AVFAudio" }],
        platforms: [{ name: "iOS", introducedAt: "3.0" }],
      },
      identifier: { interfaceLanguage: "swift" },
      abstract: [
        {
          text: "An object that communicates to the system how you intend to use audio in your app.",
        },
      ],
      primaryContentSections: [
        {
          content: [
            {
              type: "paragraph",
              inlineContent: [
                {
                  type: "text",
                  text: "Activate the audio session with setActive only when your app is ready to play.",
                },
              ],
            },
          ],
        },
      ],
    });
  };

  const response = await searchRemoteDocumentation("apple", "AVAudioSession setActive", 2, {
    apiKey: "test-key",
    fetchImplementation,
  });

  expect(searchRequests).toBe(1);
  expect(documentRequests).toBe(1);
  expect(response.warnings).toEqual([]);
  expect(response.results).toHaveLength(1);
  expect(response.results[0]).toMatchObject({
    provider: "apple",
    sourceKind: "official-api",
    title: "AVAudioSession",
    framework: "AVFAudio",
    language: "swift",
  });
  expect(response.results[0]?.passage).toContain("setActive");
});

test("SDWebImage discovery stays on its official scope and fetches static DocC JSON", async () => {
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.search.brave.com") {
      expect(url.searchParams.get("q") ?? "").toContain(
        "site:sdwebimage.github.io/documentation/sdwebimage",
      );
      return jsonResponse({
        web: {
          results: [
            {
              title: "SDWebImageManager",
              url: "https://sdwebimage.github.io/documentation/sdwebimage/sdwebimagemanager/",
            },
          ],
        },
      });
    }
    expect(url.href).toBe(
      "https://sdwebimage.github.io/data/documentation/sdwebimage/sdwebimagemanager.json",
    );
    return jsonResponse({
      metadata: {
        title: "SDWebImageManager",
        role: "symbol",
        modules: [{ name: "SDWebImage" }],
      },
      identifier: { interfaceLanguage: "swift" },
      abstract: [
        {
          type: "text",
          text: "Coordinates asynchronous image downloading with the image cache.",
        },
      ],
      primaryContentSections: [],
    });
  };

  const response = await searchRemoteDocumentation(
    "sdwebimage",
    "SDWebImageManager shared cache",
    1,
    { apiKey: "test-key", fetchImplementation },
  );

  expect(response.warnings).toEqual([]);
  expect(response.results[0]).toMatchObject({
    provider: "sdwebimage",
    sourceKind: "official-api",
    title: "SDWebImageManager",
    framework: "SDWebImage",
    language: "swift",
  });
});

test("Android discovery fetches only allowlisted official HTML and returns a bounded passage", async () => {
  let searchRequests = 0;
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.search.brave.com") {
      searchRequests++;
      expect(url.searchParams.get("q") ?? "").toContain("site:developer.android.com");
      return jsonResponse({
        web: {
          results: [
            {
              title: "MediaCodec.Callback",
              url: "https://developer.android.com/reference/android/media/MediaCodec.Callback",
            },
          ],
        },
      });
    }
    expect(url.href).toBe(
      "https://developer.android.com/reference/android/media/MediaCodec.Callback",
    );
    return new Response(
      `<!doctype html><html><head><title>MediaCodec.Callback | Android Developers</title></head>
      <body><main><h1>MediaCodec.Callback</h1><p>
      Callback interface used to notify applications asynchronously when input buffers,
      output buffers, format changes, or codec errors become available to MediaCodec.
      </p></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };

  const response = await searchRemoteDocumentation("android", "MediaCodec Callback", 1, {
    apiKey: "test-key",
    fetchImplementation,
  });

  expect(searchRequests).toBe(1);
  expect(response.results).toHaveLength(1);
  expect(response.results[0]?.url).toBe(
    "https://developer.android.com/reference/android/media/MediaCodec.Callback",
  );
  expect(response.results[0]?.passage).toContain("asynchronously");
});

test("discovery fetches only enough candidates to fill the requested result limit", async () => {
  const documentRequests: string[] = [];
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.search.brave.com") {
      return jsonResponse({
        web: {
          results: ["First", "Second", "Third", "Fourth"].map((title) => ({
            title,
            url: `https://developer.android.com/reference/example/${title}`,
          })),
        },
      });
    }
    documentRequests.push(url.pathname);
    if (url.pathname.endsWith("/First")) {
      return new Response("unavailable", { status: 503 });
    }
    return new Response(
      `<!doctype html><html><head><title>${url.pathname}</title></head>` +
        `<body><main><p>Official API documentation for ${url.pathname}. ` +
        `This reference explains the Example lifecycle, behavior, constraints, and supported usage.</p></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };

  const response = await searchRemoteDocumentation("android", "Example behavior", 2, {
    apiKey: "test-key",
    fetchImplementation,
  });

  expect(response.results).toHaveLength(2);
  expect(documentRequests).toEqual([
    "/reference/example/First",
    "/reference/example/Second",
    "/reference/example/Third",
  ]);
  expect(documentRequests).not.toContain("/reference/example/Fourth");
  expect(response.warnings[0]).toContain("/reference/example/First");
});

test("an allowlisted search result cannot redirect the fetch off-provider", async () => {
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.search.brave.com") {
      return jsonResponse({
        web: {
          results: [
            {
              title: "Activity",
              url: "https://developer.android.com/reference/android/app/Activity",
            },
          ],
        },
      });
    }
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/steal" },
    });
  };

  const response = await searchRemoteDocumentation("android", "Activity lifecycle", 1, {
    apiKey: "test-key",
    fetchImplementation,
  });
  expect(response.results).toEqual([]);
  expect(response.warnings[0]).toMatch(/outside the android network allowlist/);
});

test("Apple release searches select the platform-specific fixed scope", async () => {
  const queries: string[] = [];
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    queries.push(url.searchParams.get("q") ?? "");
    return jsonResponse({ web: { results: [] } });
  };

  await searchRemoteDocumentation("apple-releases", "Xcode 26 concurrency", 1, {
    apiKey: "test-key",
    fetchImplementation,
  });
  await searchRemoteDocumentation("apple-releases", "iOS 26 behavior changes", 1, {
    apiKey: "test-key",
    fetchImplementation,
  });

  expect(queries[0]).toContain("site:developer.apple.com/documentation/xcode-release-notes");
  expect(queries[1]).toContain("site:developer.apple.com/documentation/ios-ipados-release-notes");
});

test("web standards discovery uses fixed WHATWG and W3C scopes with standards provenance", async () => {
  let searchRequests = 0;
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "api.search.brave.com") {
      searchRequests++;
      const query = url.searchParams.get("q") ?? "";
      expect(query).toContain("site:whatwg.org");
      expect(query).toContain("site:w3c.github.io");
      return jsonResponse({
        web: {
          results: [
            { title: "Fetch Standard", url: "https://fetch.spec.whatwg.org/" },
            { title: "Unrelated W3C draft", url: "https://w3c.github.io/permissions/" },
          ],
        },
      });
    }
    expect(url.href).toBe("https://fetch.spec.whatwg.org/");
    return new Response(
      "<!doctype html><html><head><title>Fetch Standard</title></head><body><main>" +
        "<h1>Fetch</h1><p>The AbortSignal controls cancellation of a fetch request and " +
        "causes the fetch promise to reject when the operation is terminated.</p>" +
        "</main></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };

  const response = await searchRemoteDocumentation(
    "web-standards",
    "AbortSignal fetch cancellation",
    2,
    { apiKey: "test-key", fetchImplementation, sourceKinds: ["standard"] },
  );

  expect(searchRequests).toBe(1);
  expect(response.warnings).toEqual([]);
  expect(response.results).toHaveLength(1);
  expect(response.results[0]).toMatchObject({
    provider: "web-standards",
    sourceKind: "standard",
    url: "https://fetch.spec.whatwg.org/",
  });
});

test("provenance filtering skips a standards provider before network access", async () => {
  let requests = 0;
  const response = await searchRemoteDocumentation(
    "chrome-devtools-protocol",
    "Runtime evaluate",
    1,
    {
      apiKey: "test-key",
      sourceKinds: ["official-api"],
      fetchImplementation: async () => {
        requests++;
        return jsonResponse({ web: { results: [] } });
      },
    },
  );
  expect(requests).toBe(0);
  expect(response).toEqual({ results: [], warnings: [] });
});
