import { expect, test } from "bun:test";

import {
  fetchDocumentationUrl,
  resolveDirectDocumentationTarget,
} from "../../research-mcp/direct-fetch.js";

function appleMenuStyleDocument(): object {
  return {
    metadata: {
      title: "menuStyle(_:)",
      role: "symbol",
      modules: [{ name: "SwiftUI" }],
      platforms: [{ name: "iOS", introducedAt: "14.0" }],
    },
    identifier: { interfaceLanguage: "swift" },
    abstract: [{ text: "Sets the style for menus within this view." }],
    primaryContentSections: [
      {
        content: [
          {
            type: "paragraph",
            inlineContent: [
              {
                type: "text",
                text: "Use this modifier to apply a menu style to every menu in a view hierarchy.",
              },
            ],
          },
        ],
      },
    ],
  };
}

test("direct fetch accepts an allowlisted SwiftUI symbol URL and uses DocC JSON", async () => {
  const requested: string[] = [];
  const result = await fetchDocumentationUrl(
    "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
    {
      query: "menu style view hierarchy",
      limit: 1,
      fetchImplementation: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        requested.push(url.href);
        return new Response(JSON.stringify(appleMenuStyleDocument()), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  expect(requested).toEqual([
    "https://developer.apple.com/tutorials/data/documentation/swiftui/view/menustyle(_:).json",
  ]);
  expect(result).toMatchObject({
    provider: "apple",
    sourceKind: "official-api",
    canonicalUrl: "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
  });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    title: "menuStyle(_:)",
    url: "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
    framework: "SwiftUI",
    language: "swift",
  });
  expect(result.results[0]?.passage).toContain("menu style");
});

test("direct fetch rejects foreign hosts before network access", async () => {
  let requests = 0;
  await expect(
    fetchDocumentationUrl("https://attacker.example/documentation/swiftui/view", {
      fetchImplementation: async () => {
        requests++;
        return new Response("unreachable");
      },
    }),
  ).rejects.toThrow(/outside the supported documentation allowlist/);
  expect(requests).toBe(0);
});

test("direct fetch revalidates redirects against the selected provider", async () => {
  await expect(
    fetchDocumentationUrl("https://developer.android.com/reference/android/app/Activity", {
      fetchImplementation: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/steal" },
        }),
    }),
  ).rejects.toThrow(/outside the android network allowlist/);
});

test("direct URL inference prefers narrow release and dependency providers", () => {
  expect(
    resolveDirectDocumentationTarget(
      "https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes",
    ).provider,
  ).toBe("apple-releases");
  expect(
    resolveDirectDocumentationTarget(
      "https://developer.android.com/reference/androidx/media3/common/Player",
    ).provider,
  ).toBe("media3");
});
