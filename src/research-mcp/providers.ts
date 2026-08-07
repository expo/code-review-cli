import type { Platform, ProviderId } from "./types.js";

export interface DocumentationProvider {
  readonly id: ProviderId;
  readonly platform: Platform;
  readonly displayName: string;
  accepts(url: URL): boolean;
  acceptsRequest(url: URL): boolean;
  canonicalize(url: URL): URL;
  requestUrl(documentUrl: URL): URL;
  responseFormat(documentUrl: URL): "html" | "docc-json" | "markdown" | "youtrack-json";
}

interface AllowedOrigin {
  hostname: string;
  prefixes: readonly string[];
}

function isSecurePublicUrl(url: URL, hostname: string): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === hostname &&
    (url.port === "" || url.port === "443") &&
    url.username === "" &&
    url.password === ""
  );
}

function hasAllowedPath(url: URL, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
  );
}

function acceptsOrigin(url: URL, origins: readonly AllowedOrigin[]): boolean {
  return origins.some(
    ({ hostname, prefixes }) => isSecurePublicUrl(url, hostname) && hasAllowedPath(url, prefixes),
  );
}

function canonicalizeDocumentationUrl(url: URL): URL {
  const canonical = new URL(url.href);
  canonical.hash = "";
  canonical.search = "";
  canonical.hostname = canonical.hostname.toLowerCase();
  canonical.pathname = canonical.pathname.replace(/\/{2,}/g, "/");
  if (canonical.pathname.length > 1) {
    canonical.pathname = canonical.pathname.replace(/\/$/, "");
  }
  return canonical;
}

function htmlProvider(
  id: ProviderId,
  platform: Platform,
  displayName: string,
  origins: readonly AllowedOrigin[],
  preserveTrailingSlash = false,
): DocumentationProvider {
  return {
    id,
    platform,
    displayName,
    accepts(url) {
      return acceptsOrigin(url, origins);
    },
    acceptsRequest(url) {
      return this.accepts(url);
    },
    canonicalize(url) {
      const hadTrailingSlash = url.pathname.endsWith("/");
      const canonical = canonicalizeDocumentationUrl(url);
      if (preserveTrailingSlash && hadTrailingSlash && !canonical.pathname.endsWith("/")) {
        canonical.pathname += "/";
      }
      return canonical;
    },
    requestUrl(documentUrl) {
      if (preserveTrailingSlash && !documentUrl.pathname.endsWith("/")) {
        const request = new URL(documentUrl.href);
        request.pathname += "/";
        return request;
      }
      return documentUrl;
    },
    responseFormat() {
      return "html";
    },
  };
}

function appleDocCProvider(
  id: ProviderId,
  displayName: string,
  prefixes: readonly string[],
): DocumentationProvider {
  return {
    id,
    platform: "apple",
    displayName,
    accepts(url) {
      return isSecurePublicUrl(url, "developer.apple.com") && hasAllowedPath(url, prefixes);
    },
    acceptsRequest(url) {
      if (this.accepts(url)) return true;
      if (
        !isSecurePublicUrl(url, "developer.apple.com") ||
        !url.pathname.startsWith("/tutorials/data/documentation/") ||
        !url.pathname.endsWith(".json")
      ) {
        return false;
      }
      const correspondingDocumentUrl = new URL(url.href);
      correspondingDocumentUrl.pathname = url.pathname
        .slice("/tutorials/data".length)
        .replace(/\.json$/, "");
      return hasAllowedPath(correspondingDocumentUrl, prefixes);
    },
    canonicalize: canonicalizeDocumentationUrl,
    requestUrl(documentUrl) {
      if (documentUrl.pathname.startsWith("/documentation/")) {
        return new URL(
          `/tutorials/data${documentUrl.pathname.toLowerCase()}.json`,
          documentUrl.origin,
        );
      }
      return documentUrl;
    },
    responseFormat(documentUrl) {
      return documentUrl.pathname.startsWith("/documentation/") ? "docc-json" : "html";
    },
  };
}

export const appleProvider = appleDocCProvider("apple", "Apple Developer Documentation", [
  "/documentation",
  "/design/human-interface-guidelines",
]);

export const appleReleasesProvider = appleDocCProvider(
  "apple-releases",
  "Apple platform and Xcode release notes",
  [
    "/documentation/xcode-release-notes",
    "/documentation/ios-ipados-release-notes",
    "/documentation/macos-release-notes",
    "/documentation/tvos-release-notes",
    "/documentation/watchos-release-notes",
    "/documentation/visionos-release-notes",
  ],
);

const swiftEvolutionOrigins: readonly AllowedOrigin[] = [
  { hostname: "www.swift.org", prefixes: ["/swift-evolution"] },
  {
    hostname: "github.com",
    prefixes: ["/swiftlang/swift-evolution/blob/main/proposals"],
  },
];

export const swiftEvolutionProvider: DocumentationProvider = {
  id: "swift-evolution",
  platform: "apple",
  displayName: "Swift Evolution",
  accepts(url) {
    return acceptsOrigin(url, swiftEvolutionOrigins);
  },
  acceptsRequest(url) {
    return (
      this.accepts(url) ||
      (isSecurePublicUrl(url, "raw.githubusercontent.com") &&
        hasAllowedPath(url, ["/swiftlang/swift-evolution/refs/heads/main/proposals"]))
    );
  },
  canonicalize: canonicalizeDocumentationUrl,
  requestUrl(documentUrl) {
    const match = documentUrl.pathname.match(
      /^\/swiftlang\/swift-evolution\/blob\/main\/proposals\/(.+\.md)$/,
    );
    return match
      ? new URL(
          `https://raw.githubusercontent.com/swiftlang/swift-evolution/refs/heads/main/proposals/${match[1]}`,
        )
      : documentUrl;
  },
  responseFormat(documentUrl) {
    return documentUrl.hostname === "github.com" ? "markdown" : "html";
  },
};

const androidPrefixes = [
  "/build",
  "/develop",
  "/guide",
  "/jetpack",
  "/kotlin",
  "/reference",
  "/studio",
  "/topic",
  "/training",
] as const;

export const androidProvider = htmlProvider(
  "android",
  "android",
  "Android and Google Play services documentation",
  [
    { hostname: "developer.android.com", prefixes: androidPrefixes },
    { hostname: "developers.google.com", prefixes: ["/android/reference"] },
  ],
);

export const androidReleasesProvider = htmlProvider(
  "android-releases",
  "android",
  "Android platform release notes and behavior changes",
  [{ hostname: "developer.android.com", prefixes: ["/about/versions"] }],
);

export const media3Provider = htmlProvider("media3", "android", "Jetpack Media3 documentation", [
  {
    hostname: "developer.android.com",
    prefixes: ["/media/media3", "/jetpack/androidx/releases/media3", "/reference/androidx/media3"],
  },
]);

export const glideProvider = htmlProvider("glide", "android", "Glide documentation", [
  {
    hostname: "bumptech.github.io",
    prefixes: ["/glide/doc", "/glide/javadocs"],
  },
]);

// OkHttp moved from Square to the Commonhaus-backed Lysine organization in 2026.
// The maintainer and Commonhaus independently document the transfer:
// https://jakewharton.com/the-lysine-contingency/
// https://www.commonhaus.org/activity/315.html
// Use its canonical project domain instead of coupling trust to either GitHub owner name.
export const okHttpProvider = htmlProvider("okhttp", "android", "OkHttp project documentation", [
  { hostname: "lysine.dev", prefixes: ["/okhttp"] },
]);

export const kotlinCoroutinesProvider = htmlProvider(
  "kotlin-coroutines",
  "android",
  "Kotlin coroutines documentation",
  [
    {
      hostname: "kotlinlang.org",
      prefixes: ["/docs", "/api/kotlinx.coroutines"],
    },
  ],
);

export const gradleProvider = htmlProvider("gradle", "android", "Gradle documentation", [
  { hostname: "docs.gradle.org", prefixes: ["/current"] },
]);

export const agpProvider = htmlProvider("agp", "android", "Android Gradle plugin documentation", [
  {
    hostname: "developer.android.com",
    prefixes: ["/build", "/reference/tools/gradle-api"],
  },
]);

const jetbrainsIssueOrigins: readonly AllowedOrigin[] = [
  {
    hostname: "youtrack.jetbrains.com",
    prefixes: ["/issue", "/projects/IDEA/issues"],
  },
];

export const jetbrainsIssuesProvider: DocumentationProvider = {
  id: "jetbrains-issues",
  platform: "android",
  displayName: "JetBrains YouTrack issues",
  accepts(url) {
    return acceptsOrigin(url, jetbrainsIssueOrigins);
  },
  acceptsRequest(url) {
    return (
      this.accepts(url) ||
      (isSecurePublicUrl(url, "youtrack.jetbrains.com") &&
        /^\/api\/issues\/[A-Z][A-Z0-9]+-\d+$/.test(url.pathname))
    );
  },
  canonicalize: canonicalizeDocumentationUrl,
  requestUrl(documentUrl) {
    const issueId = documentUrl.pathname.match(/(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:\/|$)/)?.[1];
    if (!issueId) return documentUrl;
    const request = new URL(`https://youtrack.jetbrains.com/api/issues/${issueId}`);
    request.searchParams.set(
      "fields",
      "idReadable,summary,description,customFields(name,value(name)),comments(text,author(name),created)",
    );
    return request;
  },
  responseFormat() {
    return "youtrack-json";
  },
};

export const expoProvider = htmlProvider("expo", "react-native", "Expo documentation", [
  { hostname: "docs.expo.dev", prefixes: [""] },
]);

export const reactNativeProvider = htmlProvider(
  "react-native",
  "react-native",
  "React Native documentation",
  [
    {
      hostname: "reactnative.dev",
      prefixes: ["/docs", "/architecture"],
    },
  ],
);

export const reactNativeReanimatedProvider = htmlProvider(
  "react-native-reanimated",
  "react-native",
  "React Native Reanimated documentation",
  [
    {
      hostname: "docs.swmansion.com",
      prefixes: ["/react-native-reanimated/docs"],
    },
  ],
  true,
);

export const reactNativeGestureHandlerProvider = htmlProvider(
  "react-native-gesture-handler",
  "react-native",
  "React Native Gesture Handler documentation",
  [
    {
      hostname: "docs.swmansion.com",
      prefixes: ["/react-native-gesture-handler/docs"],
    },
  ],
  true,
);

const reactNativeScreensOrigins: readonly AllowedOrigin[] = [
  { hostname: "docs.swmansion.com", prefixes: ["/react-native-screens"] },
  {
    hostname: "github.com",
    prefixes: ["/software-mansion/react-native-screens/blob/main/README.md"],
  },
];

export const reactNativeScreensProvider: DocumentationProvider = {
  id: "react-native-screens",
  platform: "react-native",
  displayName: "React Native Screens documentation",
  accepts(url) {
    return acceptsOrigin(url, reactNativeScreensOrigins);
  },
  acceptsRequest(url) {
    return (
      this.accepts(url) ||
      (isSecurePublicUrl(url, "raw.githubusercontent.com") &&
        hasAllowedPath(url, ["/software-mansion/react-native-screens/refs/heads/main/README.md"]))
    );
  },
  canonicalize: canonicalizeDocumentationUrl,
  requestUrl(documentUrl) {
    return documentUrl.hostname === "github.com"
      ? new URL(
          "https://raw.githubusercontent.com/software-mansion/react-native-screens/refs/heads/main/README.md",
        )
      : documentUrl;
  },
  responseFormat(documentUrl) {
    return documentUrl.hostname === "github.com" ? "markdown" : "html";
  },
};

export const reactNativeWorkletsProvider = htmlProvider(
  "react-native-worklets",
  "react-native",
  "React Native Worklets documentation",
  [
    {
      hostname: "docs.swmansion.com",
      prefixes: ["/react-native-worklets/docs"],
    },
  ],
  true,
);

const providers: Record<ProviderId, DocumentationProvider> = {
  apple: appleProvider,
  "apple-releases": appleReleasesProvider,
  "swift-evolution": swiftEvolutionProvider,
  android: androidProvider,
  "android-releases": androidReleasesProvider,
  media3: media3Provider,
  glide: glideProvider,
  okhttp: okHttpProvider,
  "kotlin-coroutines": kotlinCoroutinesProvider,
  gradle: gradleProvider,
  agp: agpProvider,
  "jetbrains-issues": jetbrainsIssuesProvider,
  expo: expoProvider,
  "react-native": reactNativeProvider,
  "react-native-reanimated": reactNativeReanimatedProvider,
  "react-native-gesture-handler": reactNativeGestureHandlerProvider,
  "react-native-screens": reactNativeScreensProvider,
  "react-native-worklets": reactNativeWorkletsProvider,
};

export function getProvider(provider: ProviderId): DocumentationProvider {
  return providers[provider];
}

export function resolveAllowedUrl(
  provider: DocumentationProvider,
  rawUrl: string,
  baseUrl?: string,
): URL {
  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${provider.id} documentation URL`);
  }

  const canonical = provider.canonicalize(parsed);
  if (!provider.accepts(canonical)) {
    throw new Error(`URL is outside the ${provider.id} documentation allowlist`);
  }
  return canonical;
}

export function resolveAllowedRequestUrl(
  provider: DocumentationProvider,
  rawUrl: string,
  baseUrl?: string,
): URL {
  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${provider.id} request URL`);
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (!provider.acceptsRequest(parsed)) {
    throw new Error(`Request URL is outside the ${provider.id} network allowlist`);
  }
  return parsed;
}
