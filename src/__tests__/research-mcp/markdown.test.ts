import assert from "node:assert/strict";
import test from "node:test";

import { extractMarkdownDocumentationPage } from "../../research-mcp/markdown.js";

test("Markdown extraction keeps proposal prose and removes executable HTML", () => {
  const result = extractMarkdownDocumentationPage(
    `# Actors

Actors protect their mutable state through actor isolation.

[Structured concurrency](0304-structured-concurrency.md)

<script>ignore()</script>
`,
    "https://github.com/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md",
    "apple",
    { provider: "swift-evolution", sourceKind: "official-guide" },
  );

  assert.ok(result);
  assert.equal(result.document.title, "Actors");
  assert.equal(result.document.provider, "swift-evolution");
  assert.match(result.document.body, /actor isolation/);
  assert.doesNotMatch(result.document.body, /ignore/);
  assert.deepEqual(result.links, ["0304-structured-concurrency.md"]);
});

test("Markdown extraction recognizes Setext titles used by dependency guides", () => {
  const page = extractMarkdownDocumentationPage(
    "Caching\n=======\n\nOkHttp implements an optional cache with explicit cache hit and miss behavior.",
    "https://github.com/lysine-dev/okhttp/blob/main/docs/features/caching.md",
    "android",
    { provider: "okhttp", sourceKind: "official-guide" },
  );

  assert.equal(page?.document.title, "Caching");
  assert.match(page?.document.body ?? "", /cache hit and miss behavior/);
});
