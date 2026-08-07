import { expect, test } from "bun:test";

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

  expect(documents).toHaveLength(1);
  expect(documents[0]?.provider).toBe("expo");
  expect(documents[0]?.platform).toBe("react-native");
  expect(documents[0]?.title).toBe("CameraView");
  expect(documents[0]?.body ?? "").toMatch(/barcodeScannerSettings/);
  expect(documents[0]?.body ?? "").not.toMatch(/&lt;/);
});

test("Expo Algolia records cannot point outside official Expo documentation", () => {
  expect(() =>
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
  ).toThrow(/outside the expo documentation allowlist/);
});

test("Expo Algolia query and result bounds fail before any network request", async () => {
  await expect(searchExpoAlgolia("", 1)).rejects.toThrow(/between 1 and 300/);
  await expect(searchExpoAlgolia("CameraView", 11)).rejects.toThrow(/between 1 and 10/);
});

test("Expo provider passes the normalized documentation query directly to Algolia", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    expect(input).toBe("https://qex7pb7d46-dsn.algolia.net/1/indexes/expo/query");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const request = JSON.parse(String(init?.body)) as {
      params: string;
      facetFilters: string[][];
    };
    const params = new URLSearchParams(request.params);
    expect(params.get("query")).toBe("CameraView barcodeScannerSettings");
    expect(params.get("hitsPerPage")).toBe("2");
    expect(request.facetFilters).toEqual([["version:none", "version:latest"]]);
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
    expect(documents[0]?.title).toBe("barcodeScannerSettings");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Expo Algolia cancels an oversized streaming response", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  let pullCount = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount++;
          controller.enqueue(new Uint8Array(600_000));
          if (pullCount === 3) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    await expect(searchExpoAlgolia("CameraView", 2)).rejects.toThrow(
      "response exceeded the 1000000-byte limit",
    );
    expect(cancelled).toBe(true);
    expect(pullCount).toBeLessThanOrEqual(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
