import { expect, test } from "bun:test";

import { buildSearchIndex, searchDocumentation } from "../../research-mcp/search-index.js";
import type { IndexedChunk } from "../../research-mcp/types.js";

const chunks: IndexedChunk[] = [
  {
    id: "apple:1",
    platform: "apple",
    title: "MainActor",
    url: "https://developer.apple.com/documentation/swift/mainactor",
    passage: "A singleton actor whose executor is equivalent to the main dispatch queue.",
    language: "swift",
    nextPassageId: "apple:2",
    indexedAt: "2026-08-06T00:00:00.000Z",
  },
  {
    id: "android:1",
    platform: "android",
    title: "Activity lifecycle",
    url: "https://developer.android.com/guide/components/activities/activity-lifecycle",
    passage: "The system invokes lifecycle callbacks when an activity changes state.",
    language: "kotlin",
    indexedAt: "2026-08-06T00:00:00.000Z",
  },
];

test("search filters results by platform and language", () => {
  const index = buildSearchIndex(chunks);

  const appleResults = searchDocumentation(index, "main actor dispatch queue", {
    platform: "apple",
    language: "swift",
    limit: 5,
  });
  expect(appleResults).toHaveLength(1);
  expect(appleResults[0]?.title).toBe("MainActor");
  expect(appleResults[0]?.nextPassageId).toBe("apple:2");

  const androidResults = searchDocumentation(index, "lifecycle callbacks", {
    platform: "android",
    limit: 5,
  });
  expect(androidResults).toHaveLength(1);
  expect(androidResults[0]?.platform).toBe("android");
});

test("search rejects empty and oversized queries", () => {
  const index = buildSearchIndex(chunks);
  expect(() => searchDocumentation(index, "\u0000\n", { platform: "all", limit: 5 })).toThrow(
    /between 1 and 300/,
  );
  expect(() => searchDocumentation(index, "x".repeat(301), { platform: "all", limit: 5 })).toThrow(
    /between 1 and 300/,
  );
});

test("symbol queries do not fall back to unrelated partial matches", () => {
  const index = buildSearchIndex([
    {
      id: "android:unrelated",
      platform: "android",
      title: "Transient UI",
      url: "https://developer.android.com/example",
      passage: "A transient user interface action.",
      indexedAt: "2026-08-06T00:00:00.000Z",
    },
  ]);

  expect(
    searchDocumentation(index, "AudioManager AUDIOFOCUS_GAIN_TRANSIENT", {
      platform: "android",
      limit: 5,
    }),
  ).toEqual([]);
});

test("symbol fallback keeps results anchored by canonical identity", () => {
  const index = buildSearchIndex([
    {
      id: "apple:phasset",
      platform: "apple",
      title: "PHAsset",
      url: "https://developer.apple.com/documentation/photos/phasset",
      passage: "An image, video, or Live Photo in the Photos library.",
      indexedAt: "2026-08-06T00:00:00.000Z",
    },
  ]);

  const results = searchDocumentation(index, "PHAsset location", {
    platform: "apple",
    limit: 5,
  });
  expect(results[0]?.title).toBe("PHAsset");
});

test("symbol anchors do not match identifier suffixes or generic acronyms", () => {
  const index = buildSearchIndex([
    {
      id: "android:audio-focus-builder",
      platform: "android",
      title: "AudioFocusRequest.Builder API",
      url: "https://developer.android.com/reference/android/media/AudioFocusRequest.Builder",
      passage: "Builds an audio focus request with a custom listener.",
      indexedAt: "2026-08-06T00:00:00.000Z",
    },
  ]);

  expect(
    searchDocumentation(index, "OkHttp Request.Builder custom header API", {
      platform: "android",
      limit: 5,
    }),
  ).toEqual([]);
});

test("search filters named corpora and provenance classes", () => {
  const index = buildSearchIndex([
    {
      id: "glide:cache",
      platform: "android",
      provider: "glide",
      sourceKind: "official-guide",
      title: "Glide caching",
      url: "https://bumptech.github.io/glide/doc/caching.html",
      passage: "Configure a custom DiskCache implementation.",
      indexedAt: "2026-08-06T00:00:00.000Z",
    },
    {
      id: "jetbrains:cache",
      platform: "android",
      provider: "jetbrains-issues",
      sourceKind: "issue-tracker",
      title: "Cache issue",
      url: "https://youtrack.jetbrains.com/issue/IDEA-1",
      passage: "A user reported a DiskCache problem.",
      indexedAt: "2026-08-06T00:00:00.000Z",
    },
  ]);

  const results = searchDocumentation(index, "DiskCache", {
    platform: "android",
    providers: ["glide"],
    sourceKinds: ["official-guide"],
    limit: 5,
  });
  expect(results.map(({ provider, sourceKind }) => ({ provider, sourceKind }))).toEqual([
    { provider: "glide", sourceKind: "official-guide" },
  ]);
});

test("a language filter excludes otherwise matching untagged documents", () => {
  const index = buildSearchIndex([
    ...chunks,
    {
      id: "apple:untagged",
      platform: "apple",
      title: "MainActor overview",
      url: "https://developer.apple.com/documentation/swift/mainactor-overview",
      passage: "Main actor dispatch queue behavior without language metadata.",
      indexedAt: "2026-08-06T00:00:00.000Z",
    },
  ]);

  const results = searchDocumentation(index, "MainActor dispatch queue", {
    platform: "apple",
    language: "swift",
    limit: 5,
  });
  expect(results.map((result) => result.id)).toEqual(["apple:1"]);
});
