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

test("direct fetch resolves SDWebImage's JavaScript route through its static DocC JSON", async () => {
  const requested: string[] = [];
  const result = await fetchDocumentationUrl(
    "https://sdwebimage.github.io/documentation/sdwebimage/sdwebimagemanager/",
    {
      limit: 1,
      fetchImplementation: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        requested.push(url.href);
        return new Response(
          JSON.stringify({
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
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );

  expect(requested).toEqual([
    "https://sdwebimage.github.io/data/documentation/sdwebimage/sdwebimagemanager.json",
  ]);
  expect(result).toMatchObject({
    provider: "sdwebimage",
    sourceKind: "official-api",
    canonicalUrl: "https://sdwebimage.github.io/documentation/sdwebimage/sdwebimagemanager/",
  });
  expect(result.results[0]).toMatchObject({
    title: "SDWebImageManager",
    framework: "SDWebImage",
    language: "swift",
  });
});

test("direct fetch progressively expands focused, section, and document context", async () => {
  const paragraphs = [
    ...Array.from(
      { length: 18 },
      (_, index) =>
        `<p>Prelude ${index}: lifecycle background information ${"before ".repeat(80)}</p>`,
    ),
    `<p>UniqueTargetMember behavior: the callback runs only after the owner becomes active. ${"contract ".repeat(80)}</p>`,
    ...Array.from(
      { length: 18 },
      (_, index) =>
        `<p>Follow-up ${index}: compatibility background information ${"after ".repeat(80)}</p>`,
    ),
  ].join("\n");
  const fetchImplementation = async () =>
    new Response(
      `<!doctype html><html><head><title>TargetSymbol | Android Developers</title></head><body><main><h1>TargetSymbol</h1>${paragraphs}</main></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  const url = "https://developer.android.com/reference/android/app/Activity";

  const focused = await fetchDocumentationUrl(url, {
    query: "UniqueTargetMember behavior",
    context: "focused",
    limit: 3,
    fetchImplementation,
  });
  expect(focused.results).toHaveLength(3);
  expect(focused.results.some((result) => result.passage.includes("UniqueTargetMember"))).toBe(
    true,
  );
  expect(focused.results.some((result) => result.previousPassageId || result.nextPassageId)).toBe(
    true,
  );
  expect(focused.context).toMatchObject({
    mode: "focused",
    truncated: true,
  });
  expect(focused.context.anchorPassageId).toMatch(/#\d+$/);

  const section = await fetchDocumentationUrl(url, {
    query: "UniqueTargetMember behavior",
    context: "section",
    fetchImplementation,
  });
  expect(section.results).toHaveLength(1);
  expect(section.results[0]?.passage).toContain("UniqueTargetMember");
  expect(section.context.returnedCharacters).toBeLessThanOrEqual(12_000);
  expect(section.context.returnedCharacters).toBeGreaterThan(
    focused.results.reduce((total, result) => total + result.passage.length, 0),
  );

  const document = await fetchDocumentationUrl(url, {
    context: "document",
    fetchImplementation,
  });
  expect(document.results).toHaveLength(1);
  expect(document.context).toMatchObject({
    mode: "document",
    returnedCharacters: 20_000,
    truncated: true,
  });
  expect(document.context.documentCharacters).toBeGreaterThan(20_000);
  expect(document.context.availablePassageCount).toBeGreaterThan(3);
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
      "https://sdwebimage.github.io/documentation/sdwebimage/sdwebimagemanager/",
    ).provider,
  ).toBe("sdwebimage");
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
