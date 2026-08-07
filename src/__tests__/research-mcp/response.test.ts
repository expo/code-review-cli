import { expect, test } from "bun:test";

import { readBodyWithLimit } from "../../research-mcp/response.js";

test("response bodies are cancelled as soon as their streaming limit is exceeded", async () => {
  let cancelled = false;
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount++;
      controller.enqueue(new Uint8Array([1, 2, 3]));
      if (pullCount === 3) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readBodyWithLimit(new Response(body), 5)).rejects.toThrow(
    "response exceeded the 5-byte limit",
  );
  expect(cancelled).toBe(true);
  expect(pullCount).toBe(2);
});

test("declared oversized response bodies fail before the stream is read", async () => {
  const response = new Response("small", { headers: { "content-length": "10" } });
  await expect(readBodyWithLimit(response, 5)).rejects.toThrow("response is 10 bytes; limit is 5");
});
