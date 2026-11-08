import { describe, expect, test } from "bun:test";
import { extractBytes, safeFilename, validateSource } from "./extractor.ts";
import { EnqueueRequest, payloadDigest, safeInbox, submitter, UploadRequest } from "./index.ts";
import { pinnedAddresses, publicAddress, responseMime, sourceUrl } from "./transport.ts";

describe("ingestion security boundary", () => {
  test("rejects private, special, mapped and transition destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.1.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "198.18.0.1",
      "192.0.2.1",
      "198.51.100.2",
      "203.0.113.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "3fff::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
  test("every DNS answer must be public, including a changed second resolution", async () => {
    let calls = 0;
    const resolver = async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    expect(await pinnedAddresses("example.test", resolver)).toHaveLength(1);
    await expect(pinnedAddresses("example.test", resolver)).rejects.toThrow("destination");
    await expect(
      pinnedAddresses("example.test", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "::1", family: 6 },
      ]),
    ).rejects.toThrow();
  });
  test("rejects URL authority tricks, credential fragments and IP encodings", () => {
    for (const url of [
      "http://example.test",
      "https://user:password@example.test",
      "https://example.test:444",
      "https://127.1",
      "https://0x7f000001",
      "https://[::1]",
      "https://example.test/#password",
      "https://example.test./",
    ])
      expect(() => sourceUrl(url)).toThrow();
    expect(sourceUrl("https://example.test/path?q=sensitive").hostname).toBe("example.test");
  });
  test("redirects, compressed bodies, oversized lengths and unsafe MIME fail closed", () => {
    for (const status of [301, 302, 303, 307, 308, 401, 403])
      expect(() => responseMime(status, { "content-type": "text/html" })).toThrow();
    expect(() => responseMime(200, { "content-type": "application/pdf" })).toThrow();
    expect(() => responseMime(200, { "content-type": "text/plain", "content-encoding": "gzip" })).toThrow();
    expect(() => responseMime(200, { "content-type": "text/plain", "content-length": "5242881" })).toThrow();
    expect(responseMime(200, { "content-type": "text/html; charset=utf-8" })).toBe("text/html");
  });
  test("rejects filenames that could escape quarantine and unsupported formats", () => {
    for (const name of ["../file", "a/b", "a\\b", "..", "x\0y"]) expect(safeFilename(name)).toBe(false);
    for (const [bytes, mime] of [
      ["PK\x03\x04archive", "text/plain"],
      ["MZbinary", "text/markdown"],
      ["%PDF-1.7", "text/plain"],
      ["<html><script>evil</script>", "text/plain"],
      ["plain", "application/pdf"],
      ["text", "application/zip"],
    ])
      expect(() => validateSource(Buffer.from(bytes ?? ""), mime ?? "")).toThrow();
    expect(() => validateSource(new Uint8Array([255]), "text/plain")).toThrow();
  });
  test("extractor fails closed without a sandbox; enforces output bound", async () => {
    await expect(extractBytes(Buffer.from("hello"), "text/plain")).rejects.toThrow("unavailable");
    await expect(
      extractBytes(Buffer.from("hello"), "text/plain", async (limits) => {
        expect(limits).toMatchObject({
          network: false,
          memoryBytes: 268435456,
          cpuSeconds: 10,
          maxPages: 100,
        });
        return "x".repeat(1048577);
      }),
    ).rejects.toThrow("rejected");
  });
  test("idempotency canonicalizes key order and scopes the wiki", () => {
    const id = crypto.randomUUID();
    const wiki = crypto.randomUUID();
    const a = EnqueueRequest.parse({
      idempotencyKey: id,
      source: { kind: "text", title: "title", text: "hello" },
    });
    const b = EnqueueRequest.parse({
      source: { text: "hello", title: "title", kind: "text" },
      idempotencyKey: id,
    });
    expect(payloadDigest(wiki, a)).toBe(payloadDigest(wiki, b));
    expect(payloadDigest(crypto.randomUUID(), a)).not.toBe(payloadDigest(wiki, a));
    expect(payloadDigest(wiki, { ...a, note: "changed" })).not.toBe(payloadDigest(wiki, a));
    expect(() => EnqueueRequest.parse({ ...a, source: { kind: "file", path: "/etc/passwd" } })).toThrow();
    expect(() =>
      UploadRequest.parse({ name: "x", size: 10485761, contentType: "text/plain", sha256: "a".repeat(64) }),
    ).toThrow();
  });
  test("unprivileged caller kinds have no inbox ownership; private raw input never appears in list DTO", () => {
    expect(() => submitter({ kind: "anonymous" })).toThrow("Not found");
    const dto = safeInbox({
      id: "id",
      wikiId: "wiki",
      kind: "text",
      title: "title",
      status: "queued",
      submittedAt: new Date(0),
      input: { text: "private" },
      note: "secret",
      quarantineKey: "hidden",
    } as never);
    expect(JSON.stringify(dto)).not.toMatch(/private|secret|hidden/);
  });
});
