import { expect, test } from "bun:test";

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

  expect(result).not.toBeNull();
  expect(result?.document.title).toBe("Actors");
  expect(result?.document.provider).toBe("swift-evolution");
  expect(result?.document.body).toMatch(/actor isolation/);
  expect(result?.document.body).not.toMatch(/ignore/);
  expect(result?.links).toEqual(["0304-structured-concurrency.md"]);
});

test("Markdown extraction recognizes Setext titles used by dependency guides", () => {
  const page = extractMarkdownDocumentationPage(
    "Caching\n=======\n\nOkHttp implements an optional cache with explicit cache hit and miss behavior.",
    "https://lysine.dev/okhttp/features/caching/",
    "android",
    { provider: "okhttp", sourceKind: "official-guide" },
  );

  expect(page?.document.title).toBe("Caching");
  expect(page?.document.body ?? "").toMatch(/cache hit and miss behavior/);
});
