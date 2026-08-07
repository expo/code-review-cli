import { expect, test } from "bun:test";

import { searchOkHttpDocumentation } from "../../research-mcp/okhttp-search.js";

test("OkHttp uses its official static search index and rejects foreign locations", async () => {
  let requests = 0;
  const fetchImplementation = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests++;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.href).toBe("https://lysine.dev/okhttp/search/search_index.json");
    expect(init?.redirect).toBe("manual");
    return new Response(
      JSON.stringify({
        docs: [
          {
            location: "features/interceptors/",
            title: "Interceptors",
            text: "<p>Interceptors observe, modify, and retry OkHttp calls. Application interceptors run once while network interceptors observe redirects.</p>",
          },
          {
            location: "https://attacker.example/okhttp/interceptors",
            title: "Forged interceptors",
            text: "<p>This forged documentation must never enter the search index despite matching every query term.</p>",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const first = await searchOkHttpDocumentation("application interceptors", 2, fetchImplementation);
  const second = await searchOkHttpDocumentation("network interceptors", 2, fetchImplementation);

  expect(requests).toBe(1);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    provider: "okhttp",
    sourceKind: "official-guide",
    title: "Interceptors",
    url: "https://lysine.dev/okhttp/features/interceptors",
  });
  expect(second[0]?.passage).toContain("network interceptors");
  expect(JSON.stringify(first)).not.toContain("attacker.example");
});
