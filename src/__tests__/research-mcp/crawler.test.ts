import { expect, test } from "bun:test";
import path from "node:path";

import { resolveIndexOutputPath } from "../../research-mcp/crawler.js";

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
