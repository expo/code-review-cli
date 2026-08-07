import assert from "node:assert/strict";
import test from "node:test";

import {
  androidProvider,
  appleProvider,
  expoProvider,
  glideProvider,
  jetbrainsIssuesProvider,
  okHttpProvider,
  reactNativeGestureHandlerProvider,
  reactNativeProvider,
  reactNativeReanimatedProvider,
  reactNativeScreensProvider,
  reactNativeWorkletsProvider,
  resolveAllowedUrl,
  swiftEvolutionProvider,
} from "../../research-mcp/providers.js";

test("Apple provider accepts only HTTPS documentation paths on the exact host", () => {
  const swiftUiUrl = resolveAllowedUrl(
    appleProvider,
    "https://developer.apple.com/documentation/swiftui",
  );
  assert.equal(swiftUiUrl.href, "https://developer.apple.com/documentation/swiftui");
  assert.equal(
    appleProvider.requestUrl(swiftUiUrl).href,
    "https://developer.apple.com/tutorials/data/documentation/swiftui.json",
  );
  assert.equal(appleProvider.responseFormat(swiftUiUrl), "docc-json");
  assert.throws(
    () =>
      resolveAllowedUrl(
        appleProvider,
        "https://developer.apple.com.evil.example/documentation/swiftui",
      ),
    /outside the apple documentation allowlist/,
  );
  assert.throws(
    () => resolveAllowedUrl(appleProvider, "http://developer.apple.com/documentation/swiftui"),
    /outside the apple documentation allowlist/,
  );
  assert.throws(
    () => resolveAllowedUrl(appleProvider, "https://developer.apple.com/account"),
    /outside the apple documentation allowlist/,
  );
});

test("dependency and issue providers stay on their exact owners and paths", () => {
  assert.equal(
    resolveAllowedUrl(glideProvider, "https://bumptech.github.io/glide/doc/caching.html").hostname,
    "bumptech.github.io",
  );
  assert.equal(
    resolveAllowedUrl(
      okHttpProvider,
      "https://github.com/lysine-dev/okhttp/blob/main/docs/recipes.md",
    ).hostname,
    "github.com",
  );
  const okHttpDoc = resolveAllowedUrl(
    okHttpProvider,
    "https://github.com/lysine-dev/okhttp/blob/main/docs/features/interceptors.md",
  );
  assert.equal(
    okHttpProvider.requestUrl(okHttpDoc).href,
    "https://raw.githubusercontent.com/lysine-dev/okhttp/refs/heads/main/docs/features/interceptors.md",
  );
  assert.equal(okHttpProvider.responseFormat(okHttpDoc), "markdown");
  const proposal = resolveAllowedUrl(
    swiftEvolutionProvider,
    "https://github.com/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md",
  );
  assert.equal(proposal.pathname, "/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md");
  assert.equal(
    swiftEvolutionProvider.requestUrl(proposal).href,
    "https://raw.githubusercontent.com/swiftlang/swift-evolution/refs/heads/main/proposals/0306-actors.md",
  );
  assert.equal(swiftEvolutionProvider.responseFormat(proposal), "markdown");

  const issue = resolveAllowedUrl(
    jetbrainsIssuesProvider,
    "https://youtrack.jetbrains.com/issue/IDEA-329756",
  );
  assert.equal(issue.pathname, "/issue/IDEA-329756");
  assert.match(jetbrainsIssuesProvider.requestUrl(issue).href, /\/api\/issues\/IDEA-329756/);
  assert.equal(jetbrainsIssuesProvider.responseFormat(issue), "youtrack-json");

  for (const [provider, url] of [
    [glideProvider, "https://bumptech.github.io/other/project"],
    [okHttpProvider, "https://github.com/square/okhttp/blob/main/docs/recipes.md"],
    [okHttpProvider, "https://github.com/attacker/okhttp/blob/main/docs/recipes.md"],
    [
      swiftEvolutionProvider,
      "https://github.com/attacker/swift-evolution/blob/main/proposals/fake.md",
    ],
    [jetbrainsIssuesProvider, "https://youtrack.jetbrains.com/admin"],
  ] as const) {
    assert.throws(() => resolveAllowedUrl(provider, url), /outside the .* documentation allowlist/);
  }
});

test("Android provider canonicalizes safe links and rejects credentials and other hosts", () => {
  assert.equal(
    resolveAllowedUrl(
      androidProvider,
      "../reference/android/app/Activity?hl=en#lifecycle",
      "https://developer.android.com/develop/ui",
    ).href,
    "https://developer.android.com/reference/android/app/Activity",
  );
  assert.throws(
    () =>
      resolveAllowedUrl(
        androidProvider,
        "https://user:password@developer.android.com/reference/android/app/Activity",
      ),
    /outside the android documentation allowlist/,
  );
  assert.throws(
    () =>
      resolveAllowedUrl(
        androidProvider,
        "https://developer.android.google.cn/reference/android/app/Activity",
      ),
    /outside the android documentation allowlist/,
  );
  assert.equal(
    resolveAllowedUrl(
      androidProvider,
      "https://developers.google.com/android/reference/com/google/android/gms/location/FusedLocationProviderClient",
    ).href,
    "https://developers.google.com/android/reference/com/google/android/gms/location/FusedLocationProviderClient",
  );
  assert.throws(
    () =>
      resolveAllowedUrl(
        androidProvider,
        "https://developers.google.com/maps/documentation/android-sdk",
      ),
    /outside the android documentation allowlist/,
  );
});

test("React Native ecosystem providers stay on their exact documentation hosts and projects", () => {
  for (const [provider, url] of [
    [expoProvider, "https://docs.expo.dev/versions/latest/sdk/camera/"],
    [reactNativeProvider, "https://reactnative.dev/docs/flatlist"],
    [
      reactNativeReanimatedProvider,
      "https://docs.swmansion.com/react-native-reanimated/docs/core/useSharedValue/",
    ],
    [
      reactNativeGestureHandlerProvider,
      "https://docs.swmansion.com/react-native-gesture-handler/docs/gestures/pan-gesture/",
    ],
    [reactNativeScreensProvider, "https://docs.swmansion.com/react-native-screens/"],
    [
      reactNativeWorkletsProvider,
      "https://docs.swmansion.com/react-native-worklets/docs/fundamentals/getting-started/",
    ],
  ] as const) {
    assert.equal(resolveAllowedUrl(provider, url).hostname, new URL(url).hostname);
  }

  assert.throws(
    () =>
      resolveAllowedUrl(
        reactNativeReanimatedProvider,
        "https://docs.swmansion.com/react-native-worklets/docs/fundamentals/getting-started/",
      ),
    /outside the react-native-reanimated documentation allowlist/,
  );
  assert.throws(
    () => resolveAllowedUrl(expoProvider, "https://expo.dev/accounts"),
    /outside the expo documentation allowlist/,
  );
});
