import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = [
  {
    pr: 46119,
    platform: "react-native",
    query: "launchScanner CameraView",
    providers: ["expo"],
    url: "/versions/latest/sdk/camera",
  },
  {
    pr: 43694,
    platform: "react-native",
    query: "setUpTests",
    providers: ["react-native-reanimated"],
    url: "/react-native-reanimated/docs/guides/testing",
  },
  {
    pr: 43694,
    platform: "react-native",
    query: "Jest setup",
    providers: ["react-native-worklets"],
    url: "/react-native-worklets/docs/guides/testing",
  },
  {
    pr: 48259,
    platform: "react-native",
    query: "Pressable",
    providers: ["react-native"],
    url: "/docs/pressable",
  },
  {
    pr: 48069,
    platform: "react-native",
    query: "enableFreeze",
    providers: ["react-native-screens"],
    url: "github.com/software-mansion/react-native-screens/blob/main/README.md",
  },
  {
    pr: 47240,
    platform: "react-native",
    query: "RNS_GAMMA_ENABLED",
    providers: ["react-native-screens"],
    empty: true,
  },
  { pr: 48630, platform: "apple", query: "PHAsset location", url: "/documentation/photos/phasset" },
  { pr: 48621, query: "fontVariationSettings", url: "/reference/android/widget/TextView" },
  { pr: 48590, platform: "apple", query: "LiveActivityIntent", url: "/documentation/appintents/liveactivityintent" },
  { pr: 48557, platform: "apple", query: "NWPathMonitor pathUpdateHandler", url: "/documentation/network/nwpathmonitor" },
  { pr: 48556, query: "setConfirmationRequired", url: "/reference/androidx/biometric/BiometricPrompt.PromptInfo.Builder" },
  { pr: 48546, query: "AUDIOFOCUS_GAIN_TRANSIENT", url: "/reference/android/media/AudioManager" },
  { pr: 48521, query: "Image contentScale", url: "/reference/kotlin/androidx/compose/foundation/Image.composable" },
  { pr: 48518, query: "ConnectivityManager isActiveNetworkMetered RESTRICT_BACKGROUND_STATUS_ENABLED", url: "/reference/android/net/ConnectivityManager" },
  { pr: 48478, query: "NetworkCallback onLost", url: "/reference/android/net/ConnectivityManager.NetworkCallback" },
  { pr: 48471, query: "Intent FLAG_ACTIVITY_NO_USER_ACTION onUserLeaveHint", url: "/reference/android/content/Intent" },
  { pr: 48470, query: "NotificationManager cancel cancelAll notification ID", url: "/reference/android/app/NotificationManager" },
  { pr: 48469, query: "setRequiredNetworkType", url: "/reference/androidx/work/Constraints.Builder" },
  { pr: 48294, query: "FusedLocationProviderClient removeLocationUpdates", url: "/android/reference/com/google/android/gms/location/FusedLocationProviderClient" },
  { pr: 48310, query: "AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK", url: "/reference/android/media/AudioManager" },
  { pr: 48454, query: "Material 3 dynamic color scheme light dark", url: "/jetpack/compose/tutorial" },
  {
    pr: 48456,
    query: "Glide DiskCache custom implementation cache invalidation",
    providers: ["glide"],
    url: "/glide/doc/caching.html",
  },
  {
    pr: 48495,
    query: "IDEA-329756 symlink Gradle included build",
    providers: ["jetbrains-issues"],
    url: "/issue/IDEA-329756",
  },
  {
    pr: 48616,
    query: "Request.Builder header",
    providers: ["okhttp"],
    url: "github.com/lysine-dev/okhttp/blob/main/",
  },
  {
    pr: 48532,
    platform: "apple",
    query: "AVAudioSession setActive",
    providers: ["apple"],
    url: "/documentation/avfaudio/avaudiosession/setactive",
  },
  {
    pr: 48589,
    platform: "apple",
    query: "pushTokenUpdates",
    providers: ["apple"],
    url: "/documentation/activitykit/activity/pushtokenupdates-swift.property",
  },
  {
    pr: 48489,
    platform: "apple",
    query: "activityState",
    providers: ["apple"],
    url: "/documentation/activitykit/activity/activitystate",
  },
  {
    pr: 48489,
    platform: "apple",
    query: "widgetURL",
    providers: ["apple"],
    url: "/documentation/swiftui/view/widgeturl",
  },
  {
    pr: 48470,
    query: "MediaSessionService notification",
    providers: ["media3"],
    url: "/reference/androidx/media3/session/MediaSessionService",
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
const client = new Client({ name: "expo-pr-evaluation", version: "1.0.0" });

try {
  await client.connect(transport);
  for (const testCase of cases) {
    const response = await client.callTool({
      name: "search_platform_docs",
      arguments: {
        platform: testCase.platform ?? "android",
        query: testCase.query,
        limit: 5,
        ...(testCase.providers ? { providers: testCase.providers } : {}),
      },
    });
    const block = response.content.find((entry) => entry.type === "text");
    const payload = JSON.parse(block?.text ?? "{}");
    const results = payload.results ?? [];
    if (testCase.empty) {
      assert.equal(results.length, 0, `PR #${testCase.pr}: expected an honest empty result`);
      console.log(`PASS PR #${testCase.pr} | abstained | ${testCase.query}`);
      continue;
    }
    const match = results.find((result) => result.url.includes(testCase.url));
    assert.ok(match, `PR #${testCase.pr}: expected a result URL containing ${testCase.url}`);
    console.log(`PASS PR #${testCase.pr} | ${match.title} | ${match.url}`);
  }
} finally {
  await client.close();
}
