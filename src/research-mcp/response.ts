export async function readBodyWithLimit(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maximumBytes) {
    throw new Error(`response is ${contentLength} bytes; limit is ${maximumBytes}`);
  }
  if (!response.body) {
    throw new Error("response has no body");
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error(`response exceeded the ${maximumBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}
