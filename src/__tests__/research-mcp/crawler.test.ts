import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveIndexOutputPath, updateDocumentationIndex } from "../../research-mcp/crawler.js";

test("default index output is relative to the source config directory", () => {
  const configPath = path.join("repo", "research", "sources.json");

  expect(resolveIndexOutputPath(configPath, "data/docs-index.json")).toBe(
    path.resolve("repo", "research", "data", "docs-index.json"),
  );
});

test("an explicit output path remains relative to the caller's working directory", () => {
  expect(
    resolveIndexOutputPath(
      path.join("repo", "research", "sources.json"),
      "data/docs-index.json",
      "custom/index.json",
    ),
  ).toBe(path.resolve("custom", "index.json"));
});

test("an invalid seed is reported without aborting other seeds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-research-crawler-"));
  const configPath = path.join(directory, "sources.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      "<html><head><title>Android Widget</title></head><body><main><h1>Android Widget</h1><p>A documented Android API with enough visible text to produce a searchable local index passage.</p></main></body></html>",
      { headers: { "content-type": "text/html" } },
    );
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        output: "data/index.json",
        crawl: {
          maxPagesPerProvider: 2,
          maxDepth: 0,
          delayMs: 0,
          timeoutMs: 1000,
          maxResponseBytes: 4096,
        },
        sources: [
          {
            provider: "android",
            sourceKind: "official-api",
            seedUrls: [
              "https://untrusted.example/reference/widget",
              "https://developer.android.com/reference/widget",
            ],
          },
        ],
      }),
    );

    const result = await updateDocumentationIndex({ configPath });
    expect(result.documentCount).toBe(1);
    expect(result.providers[0]?.errors[0]).toContain("untrusted.example");
    expect(JSON.parse(await readFile(result.outputPath, "utf8")).documentCount).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
