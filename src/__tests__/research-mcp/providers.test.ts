import { expect, test } from "bun:test";

import {
  androidNdkProvider,
  androidProvider,
  appleProvider,
  appleReleasesProvider,
  chromeDevtoolsProtocolProvider,
  cmakeProvider,
  cocoaPodsProvider,
  expoProvider,
  flowProvider,
  glideProvider,
  jetbrainsIssuesProvider,
  metroProvider,
  okHttpProvider,
  reactNativeGestureHandlerProvider,
  reactNativeProvider,
  reactNativeReanimatedProvider,
  reactNativeScreensProvider,
  reactNativeWorkletsProvider,
  reactProvider,
  resolveAllowedUrl,
  resolveAllowedRequestUrl,
  sdWebImageProvider,
  swiftEvolutionProvider,
  typescriptProvider,
  webStandardsProvider,
} from "../../research-mcp/providers.js";

test("Apple provider accepts only HTTPS documentation paths on the exact host", () => {
  const swiftUiUrl = resolveAllowedUrl(
    appleProvider,
    "https://developer.apple.com/documentation/swiftui",
  );
  expect(swiftUiUrl.href).toBe("https://developer.apple.com/documentation/swiftui");
  expect(appleProvider.requestUrl(swiftUiUrl).href).toBe(
    "https://developer.apple.com/tutorials/data/documentation/swiftui.json",
  );
  expect(appleProvider.responseFormat(swiftUiUrl)).toBe("docc-json");
  expect(() =>
    resolveAllowedUrl(
      appleProvider,
      "https://developer.apple.com.evil.example/documentation/swiftui",
    ),
  ).toThrow(/outside the apple documentation allowlist/);
  expect(() =>
    resolveAllowedUrl(appleProvider, "http://developer.apple.com/documentation/swiftui"),
  ).toThrow(/outside the apple documentation allowlist/);
  expect(() => resolveAllowedUrl(appleProvider, "https://developer.apple.com/account")).toThrow(
    /outside the apple documentation allowlist/,
  );
});

test("Apple DocC request URLs retain each provider's document-prefix boundary", () => {
  expect(
    resolveAllowedRequestUrl(
      appleReleasesProvider,
      "https://developer.apple.com/tutorials/data/documentation/xcode-release-notes.json",
    ).pathname,
  ).toBe("/tutorials/data/documentation/xcode-release-notes.json");
  expect(() =>
    resolveAllowedRequestUrl(
      appleReleasesProvider,
      "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json",
    ),
  ).toThrow(/outside the apple-releases network allowlist/);
});

test("dependency and issue providers stay on their exact owners and paths", () => {
  expect(
    resolveAllowedUrl(glideProvider, "https://bumptech.github.io/glide/doc/caching.html").hostname,
  ).toBe("bumptech.github.io");
  expect(resolveAllowedUrl(okHttpProvider, "https://lysine.dev/okhttp/recipes/").hostname).toBe(
    "lysine.dev",
  );
  const okHttpDoc = resolveAllowedUrl(
    okHttpProvider,
    "https://lysine.dev/okhttp/features/interceptors/",
  );
  expect(okHttpProvider.requestUrl(okHttpDoc).href).toBe(
    "https://lysine.dev/okhttp/features/interceptors",
  );
  expect(okHttpProvider.responseFormat(okHttpDoc)).toBe("html");
  const sdWebImageDoc = resolveAllowedUrl(
    sdWebImageProvider,
    "https://sdwebimage.github.io/documentation/sdwebimage/sdwebimagemanager/",
  );
  expect(sdWebImageDoc.hostname).toBe("sdwebimage.github.io");
  expect(sdWebImageProvider.requestUrl(sdWebImageDoc).href).toBe(
    "https://sdwebimage.github.io/data/documentation/sdwebimage/sdwebimagemanager.json",
  );
  expect(
    sdWebImageProvider.acceptsRequest(
      new URL("https://sdwebimage.github.io/data/documentation/sdwebimage/sdwebimagemanager.json"),
    ),
  ).toBe(true);
  expect(sdWebImageDoc.href).toBe(
    "https://sdwebimage.github.io/documentation/sdwebimage/sdwebimagemanager/",
  );
  const proposal = resolveAllowedUrl(
    swiftEvolutionProvider,
    "https://github.com/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md",
  );
  expect(proposal.pathname).toBe("/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md");
  expect(swiftEvolutionProvider.requestUrl(proposal).href).toBe(
    "https://raw.githubusercontent.com/swiftlang/swift-evolution/refs/heads/main/proposals/0306-actors.md",
  );
  expect(swiftEvolutionProvider.responseFormat(proposal)).toBe("markdown");

  const issue = resolveAllowedUrl(
    jetbrainsIssuesProvider,
    "https://youtrack.jetbrains.com/issue/IDEA-329756",
  );
  expect(issue.pathname).toBe("/issue/IDEA-329756");
  expect(jetbrainsIssuesProvider.requestUrl(issue).href).toMatch(/\/api\/issues\/IDEA-329756/);
  expect(jetbrainsIssuesProvider.responseFormat(issue)).toBe("youtrack-json");

  for (const [provider, url] of [
    [glideProvider, "https://bumptech.github.io/other/project"],
    [okHttpProvider, "https://github.com/lysine-dev/okhttp/blob/main/docs/recipes.md"],
    [okHttpProvider, "https://github.com/square/okhttp/blob/main/docs/recipes.md"],
    [okHttpProvider, "https://github.com/attacker/okhttp/blob/main/docs/recipes.md"],
    [okHttpProvider, "https://lysine.dev/retrofit/"],
    [sdWebImageProvider, "https://sdwebimage.github.io/documentation/other-framework/"],
    [sdWebImageProvider, "https://github.com/SDWebImage/SDWebImage"],
    [
      swiftEvolutionProvider,
      "https://github.com/attacker/swift-evolution/blob/main/proposals/fake.md",
    ],
    [jetbrainsIssuesProvider, "https://youtrack.jetbrains.com/admin"],
  ] as const) {
    expect(() => resolveAllowedUrl(provider, url)).toThrow(
      /outside the .* documentation allowlist/,
    );
  }
});

test("Android provider canonicalizes safe links and rejects credentials and other hosts", () => {
  expect(
    resolveAllowedUrl(
      androidProvider,
      "../reference/android/app/Activity?hl=en#lifecycle",
      "https://developer.android.com/develop/ui",
    ).href,
  ).toBe("https://developer.android.com/reference/android/app/Activity");
  expect(() =>
    resolveAllowedUrl(
      androidProvider,
      "https://user:password@developer.android.com/reference/android/app/Activity",
    ),
  ).toThrow(/outside the android documentation allowlist/);
  expect(() =>
    resolveAllowedUrl(
      androidProvider,
      "https://developer.android.google.cn/reference/android/app/Activity",
    ),
  ).toThrow(/outside the android documentation allowlist/);
  expect(
    resolveAllowedUrl(
      androidProvider,
      "https://developers.google.com/android/reference/com/google/android/gms/location/FusedLocationProviderClient",
    ).href,
  ).toBe(
    "https://developers.google.com/android/reference/com/google/android/gms/location/FusedLocationProviderClient",
  );
  expect(() =>
    resolveAllowedUrl(
      androidProvider,
      "https://developers.google.com/maps/documentation/android-sdk",
    ),
  ).toThrow(/outside the android documentation allowlist/);
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
    [metroProvider, "https://metrobundler.dev/docs/configuration"],
  ] as const) {
    expect(resolveAllowedUrl(provider, url).hostname).toBe(new URL(url).hostname);
  }

  expect(() =>
    resolveAllowedUrl(
      reactNativeReanimatedProvider,
      "https://docs.swmansion.com/react-native-worklets/docs/fundamentals/getting-started/",
    ),
  ).toThrow(/outside the react-native-reanimated documentation allowlist/);
  expect(() => resolveAllowedUrl(expoProvider, "https://expo.dev/accounts")).toThrow(
    /outside the expo documentation allowlist/,
  );
  expect(() =>
    resolveAllowedUrl(metroProvider, "https://metrobundler.dev.evil.example/docs/configuration"),
  ).toThrow(/outside the metro documentation allowlist/);
});

test("React Native contract providers admit only their fixed authoritative corpora", () => {
  for (const [provider, url] of [
    [reactProvider, "https://react.dev/reference/react/useEffect"],
    [flowProvider, "https://flow.org/en/docs/types/unions/"],
    [typescriptProvider, "https://www.typescriptlang.org/docs/handbook/declaration-files/"],
    [androidNdkProvider, "https://developer.android.com/ndk/guides/cpp-support"],
    [cmakeProvider, "https://cmake.org/cmake/help/v3.31/command/add_library.html"],
    [cocoaPodsProvider, "https://guides.cocoapods.org/syntax/podfile.html"],
    [webStandardsProvider, "https://fetch.spec.whatwg.org/"],
    [webStandardsProvider, "https://w3c.github.io/IntersectionObserver/"],
    [
      chromeDevtoolsProtocolProvider,
      "https://chromedevtools.github.io/devtools-protocol/tot/Runtime/",
    ],
  ] as const) {
    expect(resolveAllowedUrl(provider, url).hostname).toBe(new URL(url).hostname);
  }

  for (const [provider, url] of [
    [reactProvider, "https://react.dev/reference/react-dom/components/form"],
    [reactProvider, "https://react.dev/learn/escape-hatches"],
    [flowProvider, "https://flow.org/blog/"],
    [typescriptProvider, "https://www.typescriptlang.org/play"],
    [androidNdkProvider, "https://developer.android.com/studio/projects/install-ndk"],
    [cmakeProvider, "https://cmake.org/community/"],
    [cocoaPodsProvider, "https://guides.cocoapods.org/blog/"],
    [webStandardsProvider, "https://w3c.github.io/permissions/"],
    [webStandardsProvider, "https://whatwg.org/"],
    [chromeDevtoolsProtocolProvider, "https://chromedevtools.github.io/debugger-protocol-viewer/"],
  ] as const) {
    expect(() => resolveAllowedUrl(provider, url)).toThrow(
      /outside the .* documentation allowlist/,
    );
  }

  expect(() =>
    resolveAllowedUrl(webStandardsProvider, "https://user:password@fetch.spec.whatwg.org/"),
  ).toThrow(/outside the web-standards documentation allowlist/);
  expect(() =>
    resolveAllowedUrl(androidNdkProvider, "https://developer.android.com.evil.example/ndk/guides"),
  ).toThrow(/outside the android-ndk documentation allowlist/);
  expect(() =>
    resolveAllowedUrl(reactNativeProvider, "https://reactnative.dev/contributing/overview"),
  ).toThrow(/outside the react-native documentation allowlist/);
});
