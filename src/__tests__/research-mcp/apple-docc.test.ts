import { expect, test } from "bun:test";

import { extractAppleDocCPage } from "../../research-mcp/apple-docc.js";

test("Apple DocC extraction keeps API prose, availability, and documentation links", () => {
  const page = extractAppleDocCPage(
    JSON.stringify({
      metadata: {
        title: "MainActor",
        role: "symbol",
        symbolKind: "class",
        modules: [{ name: "Swift" }],
        platforms: [{ name: "iOS", introducedAt: "13.0" }],
      },
      identifier: { interfaceLanguage: "swift" },
      abstract: [{ type: "text", text: "A singleton actor with a main-thread executor." }],
      primaryContentSections: [
        {
          kind: "declarations",
          declarations: [
            {
              tokens: [
                { kind: "keyword", text: "static" },
                { kind: "text", text: " " },
                { kind: "keyword", text: "let" },
                { kind: "text", text: " " },
                { kind: "identifier", text: "shared" },
              ],
            },
          ],
        },
        {
          kind: "content",
          content: [
            { type: "heading", text: "Overview" },
            {
              type: "paragraph",
              inlineContent: [{ type: "text", text: "Use this actor for UI work." }],
            },
          ],
        },
      ],
      references: {
        child: {
          url: "/documentation/swift/mainactor/run(resulttype:body:)",
          title: "run(resultType:body:)",
        },
        external: { url: "https://example.com", title: "External" },
      },
    }),
    "https://developer.apple.com/documentation/swift/mainactor",
  );

  expect(page).not.toBeNull();
  expect(page?.document.title).toBe("MainActor");
  expect(page?.document.framework).toBe("Swift");
  expect(page?.document.language).toBe("swift");
  expect(page?.document.availability).toEqual(["iOS 13.0"]);
  expect(page?.document.body).toMatch(/main-thread executor/);
  expect(page?.document.body).toMatch(/Use this actor for UI work/);
  expect(page?.document.body).toContain("static let shared");
  expect(page?.links).toEqual(["/documentation/swift/mainactor/run(resulttype:body:)"]);
});
