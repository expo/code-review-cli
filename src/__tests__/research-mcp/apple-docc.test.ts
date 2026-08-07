import assert from "node:assert/strict";
import test from "node:test";

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

  assert.ok(page);
  assert.equal(page.document.title, "MainActor");
  assert.equal(page.document.framework, "Swift");
  assert.equal(page.document.language, "swift");
  assert.deepEqual(page.document.availability, ["iOS 13.0"]);
  assert.match(page.document.body, /main-thread executor/);
  assert.match(page.document.body, /Use this actor for UI work/);
  assert.deepEqual(page.links, ["/documentation/swift/mainactor/run(resulttype:body:)"]);
});
