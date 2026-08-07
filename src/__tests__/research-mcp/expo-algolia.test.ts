import assert from "node:assert/strict";
import test from "node:test";

import { extractExpoAlgoliaDocuments, searchExpoAlgolia } from "../../research-mcp/expo-algolia.js";

test("Expo Algolia records become bounded official documents without highlight markup", () => {
  const documents = extractExpoAlgoliaDocuments(
    JSON.stringify({
      hits: [
        {
          objectID: "camera-view",
          url: "https://docs.expo.dev/versions/latest/sdk/camera/#cameraview",
          content: "&lt;CameraView barcodeScannerSettings={{ barcodeTypes: ['qr'] }} /&gt;",
          language: "en",
          hierarchy: {
            lvl0: "Expo Camera",
            lvl1: "A component that renders a device camera preview.",
            lvl2: "Component",
            lvl3: "CameraView",
          },
        },
      ],
    }),
  );

  assert.equal(documents.length, 1);
  assert.equal(documents[0]?.provider, "expo");
  assert.equal(documents[0]?.platform, "react-native");
  assert.equal(documents[0]?.title, "CameraView");
  assert.match(documents[0]?.body ?? "", /barcodeScannerSettings/);
  assert.doesNotMatch(documents[0]?.body ?? "", /&lt;/);
});

test("Expo Algolia records cannot point outside official Expo documentation", () => {
  assert.throws(
    () =>
      extractExpoAlgoliaDocuments(
        JSON.stringify({
          hits: [
            {
              objectID: "forged",
              url: "https://attacker.example/expo",
              content: "Forged documentation content",
              hierarchy: { lvl0: "Forged" },
            },
          ],
        }),
      ),
    /outside the expo documentation allowlist/,
  );
});

test("Expo Algolia query and result bounds fail before any network request", async () => {
  await assert.rejects(() => searchExpoAlgolia("", 1), /between 1 and 300/);
  await assert.rejects(() => searchExpoAlgolia("CameraView", 11), /between 1 and 10/);
});

test("Expo provider passes the normalized documentation query directly to Algolia", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.equal(input, "https://qex7pb7d46-dsn.algolia.net/1/indexes/expo/query");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const request = JSON.parse(String(init?.body)) as {
      params: string;
      facetFilters: string[][];
    };
    const params = new URLSearchParams(request.params);
    assert.equal(params.get("query"), "CameraView barcodeScannerSettings");
    assert.equal(params.get("hitsPerPage"), "2");
    assert.deepEqual(request.facetFilters, [["version:none", "version:latest"]]);
    return new Response(
      JSON.stringify({
        hits: [
          {
            objectID: "barcode-scanner-settings",
            url: "https://docs.expo.dev/versions/latest/sdk/camera/#barcodescannersettings",
            content: "Settings for the barcode scanner used by CameraView.",
            hierarchy: { lvl0: "Expo Camera", lvl1: "barcodeScannerSettings" },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const documents = await searchExpoAlgolia("  CameraView   barcodeScannerSettings  ", 2);
    assert.equal(documents[0]?.title, "barcodeScannerSettings");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
