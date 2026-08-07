import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSearchIndex,
  loadSearchIndex,
  searchDocumentation,
  writeSearchIndex,
} from "../../research-mcp/search-index.js";
import type { IndexedChunk } from "../../research-mcp/types.js";

const chunks: IndexedChunk[] = [
  {
    id: "apple:1",
    platform: "apple",
    title: "MainActor",
    url: "https://developer.apple.com/documentation/swift/mainactor",
    passage: "A singleton actor whose executor is equivalent to the main dispatch queue.",
    language: "swift",
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

test("a serialized index reloads and filters search results by platform", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-research-index-"));
  try {
    const filePath = path.join(directory, "index.json");
    const built = buildSearchIndex(chunks, 2, "2026-08-06T00:00:00.000Z");
    await writeSearchIndex(filePath, built.serialized);
    const loaded = await loadSearchIndex(filePath);

    const appleResults = searchDocumentation(loaded, "main actor dispatch queue", {
      platform: "apple",
      language: "swift",
      limit: 5,
    });
    assert.equal(appleResults.length, 1);
    assert.equal(appleResults[0]?.title, "MainActor");

    const androidResults = searchDocumentation(loaded, "lifecycle callbacks", {
      platform: "android",
      limit: 5,
    });
    assert.equal(androidResults.length, 1);
    assert.equal(androidResults[0]?.platform, "android");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search rejects empty and oversized queries", () => {
  const index = buildSearchIndex(chunks, 2);
  assert.throws(
    () => searchDocumentation(index, "\u0000\n", { platform: "all", limit: 5 }),
    /between 1 and 300/,
  );
  assert.throws(
    () => searchDocumentation(index, "x".repeat(301), { platform: "all", limit: 5 }),
    /between 1 and 300/,
  );
});

test("symbol queries do not fall back to unrelated partial matches", () => {
  const index = buildSearchIndex(
    [
      {
        id: "android:unrelated",
        platform: "android",
        title: "Transient UI",
        url: "https://developer.android.com/example",
        passage: "A transient user interface action.",
        indexedAt: "2026-08-06T00:00:00.000Z",
      },
    ],
    1,
  );

  assert.deepEqual(
    searchDocumentation(index, "AudioManager AUDIOFOCUS_GAIN_TRANSIENT", {
      platform: "android",
      limit: 5,
    }),
    [],
  );
});

test("symbol fallback keeps results anchored by canonical identity", () => {
  const index = buildSearchIndex(
    [
      {
        id: "apple:phasset",
        platform: "apple",
        title: "PHAsset",
        url: "https://developer.apple.com/documentation/photos/phasset",
        passage: "An image, video, or Live Photo in the Photos library.",
        indexedAt: "2026-08-06T00:00:00.000Z",
      },
    ],
    1,
  );

  const results = searchDocumentation(index, "PHAsset location", {
    platform: "apple",
    limit: 5,
  });
  assert.equal(results[0]?.title, "PHAsset");
});

test("symbol anchors do not match identifier suffixes or generic acronyms", () => {
  const index = buildSearchIndex(
    [
      {
        id: "android:audio-focus-builder",
        platform: "android",
        title: "AudioFocusRequest.Builder API",
        url: "https://developer.android.com/reference/android/media/AudioFocusRequest.Builder",
        passage: "Builds an audio focus request with a custom listener.",
        indexedAt: "2026-08-06T00:00:00.000Z",
      },
    ],
    1,
  );

  assert.deepEqual(
    searchDocumentation(index, "OkHttp Request.Builder custom header API", {
      platform: "android",
      limit: 5,
    }),
    [],
  );
});

test("search filters named corpora and provenance classes", () => {
  const index = buildSearchIndex(
    [
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
    ],
    2,
  );

  const results = searchDocumentation(index, "DiskCache", {
    platform: "android",
    providers: ["glide"],
    sourceKinds: ["official-guide"],
    limit: 5,
  });
  assert.deepEqual(
    results.map(({ provider, sourceKind }) => ({ provider, sourceKind })),
    [{ provider: "glide", sourceKind: "official-guide" }],
  );
});
