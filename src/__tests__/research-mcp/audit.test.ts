import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readResearchAudit, ResearchAudit } from "../../research-mcp/audit.js";

test("research audit shares one call budget and records bounded completed results", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "research-audit-"));
  const auditPath = path.join(directory, "audit.jsonl");
  try {
    const first = new ResearchAudit(auditPath, 2);
    const second = new ResearchAudit(auditPath, 2);
    const one = await first.reserve("search_platform_docs", {
      platform: "apple",
      providers: ["apple"],
      query: "MainActor",
    });
    const two = await second.reserve("fetch_platform_doc", {
      providers: ["apple"],
      url: "https://developer.apple.com/documentation/swift/mainactor",
    });
    await first.complete(one, "search_platform_docs", { query: "MainActor" }, [
      {
        id: "apple:mainactor",
        platform: "apple",
        provider: "apple",
        sourceKind: "official-api",
        title: "MainActor",
        url: "https://developer.apple.com/documentation/swift/mainactor",
        passage: "Main actor documentation.",
        indexedAt: "2026-08-07T00:00:00.000Z",
      },
    ]);
    await second.fail(two, "fetch_platform_doc", { url: "https://developer.apple.com" }, "no page");
    await expect(first.reserve("search_platform_docs", { query: "View" })).rejects.toThrow(
      /call budget exhausted \(2\)/,
    );
    const records = await readResearchAudit(auditPath);
    expect(records).toHaveLength(2);
    expect(records[0]?.results[0]?.title).toBe("MainActor");
    expect(records[1]?.error).toBe("no page");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
