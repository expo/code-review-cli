import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ReviewConfigSchema, ScopeReviewConfigSchema } from "../config/schema.js";
import {
  boundResearchDecisions,
  countUngroundedExternalClaims,
  formatResearchProgress,
  formatResearchUsefulness,
  groundResearchDecisions,
  groundResearchSources,
  renderResearchMarkdown,
  renderResearchUsefulnessMarkdown,
  researchChildEnvironment,
  RESEARCH_DECISION_BYTES_LIMIT,
  RESEARCH_DECISION_COUNT_LIMIT,
  summarizeResearchUsefulness,
  toResearchProvenance,
} from "../core/research.js";

/**
 * The declared `env` block is NOT the boundary. Both Claude Code and OpenCode merge
 * it onto the environment they already hold, so this asserts on the environment the
 * wrapper actually hands the server — the only place the guarantee is real.
 */
test("the wrapper hands the MCP server a constructed environment, not an inherited one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ecr-wrapper-test-"));
  try {
    const recordPath = path.join(directory, "record.json");
    // Stands in for the real server: the wrapper resolves ./cli.{js,ts} beside itself.
    await writeFile(
      path.join(directory, "cli.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(Object.keys(process.env).sort()));\n`,
      "utf8",
    );
    for (const name of ["wrapper.ts", "child-env.ts"]) {
      await copyFile(
        fileURLToPath(new URL(`../research-mcp/${name}`, import.meta.url)),
        path.join(directory, name),
      );
    }

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [path.join(directory, "wrapper.ts"), "serve"], {
        env: {
          // Everything an engine was measured to merge in, plus the legitimate block.
          PATH: process.env.PATH ?? "",
          HOME: "/root",
          ANTHROPIC_API_KEY: "must-not-reach-the-server",
          META_API_KEY: "must-not-reach-the-server",
          CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-the-server",
          AWS_SECRET_ACCESS_KEY: "must-not-reach-the-server",
          GITHUB_TOKEN: "must-not-reach-the-server",
          OPENCODE_CONFIG_CONTENT: "{}",
          NODE_OPTIONS: "--require /evil.js",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          BRAVE_SEARCH_API_KEY: "search-only",
          REVIEW_RESEARCH_AUDIT_PATH: path.join(directory, "audit.jsonl"),
          REVIEW_RESEARCH_MAX_CALLS: "8",
          REVIEW_RESEARCH_MAX_RESULTS: "2",
          REVIEW_RESEARCH_TIMEOUT_MS: "30000",
        },
        stdio: "ignore",
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
    expect(exitCode).toBe(0);

    const names = JSON.parse(await readFile(recordPath, "utf8")) as string[];
    expect(names.sort()).toEqual([
      "BRAVE_SEARCH_API_KEY",
      "LANG",
      "LC_ALL",
      "REVIEW_RESEARCH_AUDIT_PATH",
      "REVIEW_RESEARCH_MAX_CALLS",
      "REVIEW_RESEARCH_MAX_RESULTS",
      "REVIEW_RESEARCH_TIMEOUT_MS",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("research child environment forwards only locale, proxy variables, and the fixed search key", () => {
  expect(
    researchChildEnvironment({
      HTTPS_PROXY: "http://proxy.example:8080",
      no_proxy: "localhost",
      BRAVE_SEARCH_API_KEY: "search-only",
      SECRET_TOKEN: "must-not-be-forwarded",
      META_API_KEY: "must-not-be-forwarded",
      PATH: "/private/bin",
    }),
  ).toMatchObject({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HTTPS_PROXY: "http://proxy.example:8080",
    no_proxy: "localhost",
    BRAVE_SEARCH_API_KEY: "search-only",
  });
  expect(researchChildEnvironment({ SECRET_TOKEN: "nope" })).not.toHaveProperty("SECRET_TOKEN");
  expect(researchChildEnvironment({ META_API_KEY: "nope" })).not.toHaveProperty("META_API_KEY");
  expect(researchChildEnvironment({ PATH: "/private/bin" })).not.toHaveProperty("PATH");
});

test("research is root-only and rejects an unknown key", () => {
  expect(ReviewConfigSchema.safeParse({ research: { enabled: true } }).success).toBe(true);
  // The offline index is gone; a stale config naming it must fail loudly rather
  // than be silently ignored.
  expect(
    ReviewConfigSchema.safeParse({ research: { enabled: true, indexPath: "/tmp/index.json" } })
      .success,
  ).toBe(false);
  expect(ScopeReviewConfigSchema.safeParse({ research: { enabled: false } }).success).toBe(false);
});

test("research provenance exposes each bounded query and exact result in logs and step Markdown", () => {
  const query = {
    platform: "apple" as const,
    providers: ["apple"],
    query: "NWPathMonitor pathUpdateHandler",
  };
  const provenance = toResearchProvenance({
    queries: [query],
    evidence: [
      {
        id: "remote:apple:nwpathmonitor",
        query,
        provider: "apple",
        sourceKind: "official-api",
        title: "NWPathMonitor",
        url: "https://developer.apple.com/documentation/network/nwpathmonitor",
        passage: "Observe network path changes with a path update handler.",
      },
    ],
    warnings: [],
  });

  expect(provenance.results[0]?.passage).toContain("path update handler");
  expect(formatResearchProgress(provenance)).toEqual([
    "  research: 1 result(s) from 1 bounded query(s)",
    "  research query 1/1 — apple [apple]: NWPathMonitor pathUpdateHandler",
    "    result: NWPathMonitor (apple/official-api) — https://developer.apple.com/documentation/network/nwpathmonitor",
  ]);
  const summary = renderResearchMarkdown(provenance);
  expect(summary).toContain("`NWPathMonitor pathUpdateHandler`");
  expect(summary).toContain(
    "[NWPathMonitor](<https://developer.apple.com/documentation/network/nwpathmonitor>)",
  );
});

test("rejected research calls surface by reason class in progress and Markdown output", () => {
  const provenance = {
    ...toResearchProvenance({ queries: [], evidence: [], warnings: [] }),
    rejections: [
      { tool: "search_platform_docs", reason: "budget-exhausted", count: 2 },
      { tool: "fetch_platform_doc", reason: "url-rejected", count: 1 },
    ],
  };
  const progress = formatResearchProgress(provenance).join("\n");
  expect(progress).toContain(
    "2 search_platform_docs call(s) rejected before execution (budget-exhausted)",
  );
  expect(progress).toContain(
    "1 fetch_platform_doc call(s) rejected before execution (url-rejected)",
  );
  const markdown = renderResearchMarkdown(provenance);
  expect(markdown).toContain("rejected before execution (budget-exhausted)");
});

test("finding citations are exact selections from research evidence", () => {
  const evidence = [
    {
      query: { platform: "apple" as const, providers: ["apple"], query: "menuStyle" },
      provider: "apple",
      sourceKind: "official-api",
      title: "menuStyle(_:)",
      url: "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
      passage: "Sets the style for menus within this view.",
    },
  ];
  const [finding] = groundResearchSources(
    [
      {
        severity: "warning",
        category: "correctness",
        file: "Menu.swift",
        line: 12,
        title: "Menu style is applied to the wrong hierarchy",
        rationale: "The modifier affects descendants.",
        sources: [
          {
            title: "forged title",
            url: "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
          },
          { title: "attacker", url: "https://attacker.example/fake" },
        ],
      },
    ],
    evidence,
  );

  expect(finding?.sources).toEqual([
    {
      title: "menuStyle(_:)",
      url: "https://developer.apple.com/documentation/swiftui/view/menustyle(_:)",
    },
  ]);
});

test("a citation that drops the URL fragment still grounds to the audited URL", () => {
  const evidence = [
    {
      query: { platform: "react-native" as const, providers: ["expo"], query: "CameraView" },
      provider: "expo",
      sourceKind: "official-api",
      title: "CameraView barcodeScannerSettings",
      url: "https://docs.expo.dev/versions/latest/sdk/camera#barcodescannersettings",
      passage: "Configures the scanned barcode formats.",
    },
  ];
  const [finding] = groundResearchSources(
    [
      {
        severity: "warning",
        category: "correctness",
        file: "Camera.tsx",
        line: 3,
        title: "Scanner formats are not configured",
        rationale: "The documented default excludes this format.",
        sources: [
          // The model normalized the copied URL by dropping the fragment.
          { title: "CameraView", url: "https://docs.expo.dev/versions/latest/sdk/camera" },
          // A different host never matches, fragment or not.
          { title: "attacker", url: "https://attacker.example/sdk/camera" },
        ],
      },
    ],
    evidence,
  );
  expect(finding?.sources).toEqual([
    {
      title: "CameraView barcodeScannerSettings",
      url: "https://docs.expo.dev/versions/latest/sdk/camera#barcodescannersettings",
    },
  ]);
});

test("research usefulness counts grounded candidate decisions and unique used results", () => {
  const query = { platform: "apple" as const, providers: ["apple"], query: "Widget behavior" };
  const evidence = [
    {
      query,
      provider: "apple",
      sourceKind: "official-api",
      title: "Widget API",
      url: "https://developer.apple.com/documentation/widgetkit/widget",
      passage: "A widget contract.",
    },
    {
      query,
      provider: "apple",
      sourceKind: "official-guide",
      title: "Widget lifecycle",
      url: "https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date",
      passage: "A lifecycle contract.",
    },
    {
      query,
      provider: "apple",
      sourceKind: "official-guide",
      title: "Unused result",
      url: "https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension",
      passage: "Background only.",
    },
  ];
  const decisions = groundResearchDecisions(
    [
      {
        outcome: "supported-finding",
        summary: "The documented lifecycle confirms the stale update path.",
        sources: [{ title: "forged", url: evidence[0]!.url }],
      },
      {
        outcome: "dismissed-candidate",
        summary: "The documented default makes the suspected fallback safe.",
        sources: [{ title: "forged", url: evidence[1]!.url }],
      },
      {
        outcome: "supported-finding",
        summary: "This declaration is not grounded.",
        sources: [{ title: "attacker", url: "https://attacker.example/fake" }],
      },
    ],
    evidence,
    "correctness",
  );
  expect(decisions).toHaveLength(2);
  expect(decisions[0]?.sources[0]?.title).toBe("Widget API");

  const provenance = {
    ...toResearchProvenance({ queries: [query], evidence, warnings: [] }),
    decisions,
  };
  const usefulness = summarizeResearchUsefulness(provenance, [
    {
      severity: "warning",
      category: "correctness",
      file: "Widget.swift",
      line: 12,
      title: "Widget update stays stale",
      rationale: "The update does not reload.",
      sources: [{ title: "Widget API", url: evidence[0]!.url }],
    },
  ]);
  expect(usefulness).toEqual({
    finalFindingsWithSources: 1,
    citedResultCount: 1,
    supportedFindingCandidates: 1,
    dismissedCandidates: 1,
    decisionResultCount: 2,
    utilizedResultCount: 2,
    unusedResultCount: 1,
    externalClaimFindingsWithoutSources: 0,
  });
  expect(formatResearchUsefulness(usefulness)).toContain("2 result(s) materially used, 1 unused");
  const markdown = renderResearchUsefulnessMarkdown({ ...provenance, usefulness });
  expect(markdown).toContain("**2/3**");
  expect(markdown).toContain("**Supported finding** (correctness)");
  expect(markdown).toContain(
    "[Widget API](<https://developer.apple.com/documentation/widgetkit/widget>)",
  );
});

test("cross-agent research decisions are deterministic and bounded by count and bytes", () => {
  const decisions = Array.from({ length: 24 }, (_, index) => ({
    outcome: index % 2 === 0 ? ("supported-finding" as const) : ("dismissed-candidate" as const),
    summary: `${String(24 - index).padStart(2, "0")}-${"s".repeat(220)}`,
    sources: [
      {
        title: "T".repeat(220),
        url: `https://developer.apple.com/documentation/example/${String(index).padStart(2, "0")}/${"u".repeat(1_200)}`,
      },
    ],
    agent: `agent-${String(24 - index).padStart(2, "0")}`,
  }));

  const bounded = boundResearchDecisions(decisions);
  expect(bounded.decisions.length).toBeLessThanOrEqual(RESEARCH_DECISION_COUNT_LIMIT);
  expect(Buffer.byteLength(JSON.stringify(bounded.decisions), "utf8")).toBeLessThanOrEqual(
    RESEARCH_DECISION_BYTES_LIMIT,
  );
  expect(bounded.omitted).toBe(decisions.length - bounded.decisions.length);
  expect(bounded.decisions.map((decision) => decision.agent)).toEqual(
    bounded.decisions.map((decision) => decision.agent).sort(),
  );
});

test("ungrounded external platform claims are counted; cited or code-local findings are not", () => {
  const base = {
    severity: "warning" as const,
    category: "correctness" as const,
    file: "a.ts",
    line: 1,
  };
  expect(
    countUngroundedExternalClaims([
      // Version claim, no citation → counted.
      { ...base, title: "Needs iOS 16.1", rationale: "pushTokenUpdates requires iOS 16.1." },
      // API-level claim, no citation → counted.
      { ...base, title: "Wrong constant", rationale: "This flag was removed in API level 34." },
      // Same claim WITH a grounded citation → not counted.
      {
        ...base,
        title: "Needs iOS 16.1",
        rationale: "pushTokenUpdates requires iOS 16.1.",
        sources: [
          {
            title: "pushTokenUpdates",
            url: "https://developer.apple.com/documentation/activitykit",
          },
        ],
      },
      // Code-local claim → not counted.
      { ...base, title: "Null check missing", rationale: "The handler dereferences undefined." },
    ]),
  ).toBe(2);
});
