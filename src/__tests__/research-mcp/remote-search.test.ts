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
