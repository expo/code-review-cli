import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = [
  {
    provider: "media3",
    query: "MediaSessionService background playback notification",
    expected: "developer.android.com",
  },
  {
    provider: "glide",
    query: "DiskCache custom implementation cache invalidation",
    expected: "bumptech.github.io",
  },
  {
    provider: "okhttp",
    query: "Request.Builder header",
    expected: "lysine.dev/okhttp/",
  },
  {
    provider: "kotlin-coroutines",
    query: "coroutine cancellation cooperative",
    expected: "kotlinlang.org",
  },
  {
    provider: "gradle",
    query: "Tooling API composite included builds",
    expected: "docs.gradle.org",
  },
  {
    provider: "agp",
    query: "Android Gradle Plugin API removed DSL",
    expected: "developer.android.com/build/",
  },
  {
    provider: "swift-evolution",
    platform: "apple",
    query: "Swift Evolution actors concurrency",
    expected: "github.com/swiftlang/swift-evolution/blob/main/proposals/",
  },
  {
    provider: "apple-releases",
    platform: "apple",
    query: "Xcode release notes Swift",
    expected: "developer.apple.com/documentation/xcode-release-notes/",
  },
  {
    provider: "android-releases",
    query: "Android 16 local network protection",
    expected: "developer.android.com/about/versions/16/",
  },
  {
    provider: "jetbrains-issues",
    query: "IDEA-329756 symlink Gradle included build",
    expected: "youtrack.jetbrains.com",
    sourceKind: "issue-tracker",
  },
  {
    provider: "expo",
    platform: "react-native",
    query: "CameraView barcodeScannerSettings",
    expected: "docs.expo.dev/versions/latest/sdk/camera#barcodescannersettings",
  },
  {
    provider: "react-native",
    platform: "react-native",
    query: "FlatList getItemLayout",
    expected: "reactnative.dev/docs/flatlist",
  },
  {
    provider: "react-native-reanimated",
    platform: "react-native",
    query: "useSharedValue",
    expected: "/react-native-reanimated/docs/core/useSharedValue",
  },
  {
    provider: "react-native-gesture-handler",
    platform: "react-native",
    query: "GestureDetector",
    expected: "/react-native-gesture-handler/docs/core-components/gesture-detectors",
  },
  {
    provider: "react-native-screens",
    platform: "react-native",
    query: "enableFreeze",
    expected: "github.com/software-mansion/react-native-screens/blob/main/README.md",
  },
  {
    provider: "react-native-worklets",
    platform: "react-native",
    query: "scheduleOnUI",
    expected: "/react-native-worklets/docs/",
  },
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(root, "build/research-mcp/cli.js"),
    "serve",
    "--index",
    path.join(root, "research/data/docs-index.json"),
  ],
  stderr: "pipe",
});
const client = new Client({ name: "corpus-evaluation", version: "1.0.0" });

try {
  await client.connect(transport);
  for (const testCase of cases) {
    const response = await client.callTool({
      name: "search_platform_docs",
      arguments: {
        platform: testCase.platform ?? "android",
        providers: [testCase.provider],
        query: testCase.query,
        limit: 5,
      },
    });
    const block = response.content.find((entry) => entry.type === "text");
    const payload = JSON.parse(block?.text ?? "{}");
    const match = (payload.results ?? []).find(
      (result) =>
        result.provider === testCase.provider &&
        result.url.includes(testCase.expected) &&
        (!testCase.sourceKind || result.sourceKind === testCase.sourceKind)
    );
    assert.ok(match, `${testCase.provider}: expected an authoritative corpus result`);
    console.log(
      `PASS ${testCase.provider} | ${match.sourceKind} | ${match.title} | ${match.url}`
    );
  }
} finally {
  await client.close();
}
