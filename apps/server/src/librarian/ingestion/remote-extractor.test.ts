import { expect, test } from "bun:test";
import { checkKey, matches, remoteExtractor, signature } from "./remote-extractor.ts";

const key = new Uint8Array(32).fill(77); // Synthetic only.
test("explicit fixed endpoint and 256-bit key required", () => {
  for (const endpoint of [
    "http://private.test",
    "https://user:pass@private.test",
    "https://private.test/path",
    "https://private.test/?url=other",
  ]) {
    expect(() => remoteExtractor({ endpoint, key })).toThrow();
  }
  expect(() => checkKey(new Uint8Array(16))).toThrow();
  expect(matches(signature(key, ["a"]), signature(key, ["b"]))).toBe(false);
});
test("client rejects unauthenticated result", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("untrusted") });
  try {
    const client = remoteExtractor({
      endpoint: `http://127.0.0.1:${server.port}`,
      key,
      testOnlyLoopbackHttp: true,
    });
    await expect(
      client({
        bytes: Buffer.from("hello"),
        mime: "text/plain",
        network: false,
        memoryBytes: 268435456,
        cpuSeconds: 10,
        maxPages: 100,
        maxOutputBytes: 1048576,
      }),
    ).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});
