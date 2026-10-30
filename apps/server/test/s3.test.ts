import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bucket, bucketOrigin, PreconditionFailed } from "../src/s3.ts";
import { testEnv } from "./helpers.ts";

describe("Bucket against SeaweedFS", () => {
  const config = testEnv("postgres://unused", { S3_BUCKET: `t-${crypto.randomUUID().slice(0, 8)}` }).s3;
  const IMMUTABLE = "public, max-age=31536000, immutable";
  let time = new Date("2026-10-30T09:15:00Z");
  const bucket = new Bucket(config, { now: () => time });
  const key = (name: string) => `${crypto.randomUUID()}/${name}`;

  beforeAll(async () => {
    expect(await bucket.ensure()).toBe("created");
  });
  afterAll(() => {
    time = new Date();
  });

  test("ensure leaves an existing bucket alone", async () => {
    expect(await bucket.ensure()).toBe("exists");
  });

  test("put, get, head and delete", async () => {
    const k = key("a.json");
    const { etag } = await bucket.put(k, '{"v":1}', {
      contentType: "application/json",
      cacheControl: IMMUTABLE,
    });
    expect(etag).not.toContain('"');

    const got = await bucket.get(k);
    expect(new TextDecoder().decode(got?.body)).toBe('{"v":1}');
    expect(got).toMatchObject({ etag, contentType: "application/json" });

    expect(await bucket.head(k)).toMatchObject({ etag, size: 7, cacheControl: IMMUTABLE });

    await bucket.delete(k);
    expect(await bucket.get(k)).toBeNull();
    expect(await bucket.head(k)).toBeNull();
  });

  test("getRange reads part of an object, both ends included", async () => {
    const k = key("range.bin");
    await bucket.put(k, "0123456789");
    expect(new TextDecoder().decode((await bucket.getRange(k, 2, 5)) as Uint8Array)).toBe("2345");
    expect(new TextDecoder().decode((await bucket.getRange(k, 8, 99)) as Uint8Array)).toBe("89");
    expect(await bucket.getRange(key("none"), 0, 1)).toBeNull();
  });

  test("list pages through a prefix", async () => {
    const prefix = `${crypto.randomUUID()}/`;
    await Promise.all(["a", "b", "c"].map((name) => bucket.put(prefix + name, name)));
    const first = await bucket.list(prefix, { limit: 2 });
    expect(first.objects).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await bucket.list(prefix, { limit: 2, cursor: first.nextCursor as string });
    expect([...first.objects, ...second.objects].map((object) => object.key).sort()).toEqual(
      ["a", "b", "c"].map((name) => prefix + name),
    );
    expect(second.nextCursor).toBeNull();
  });

  describe("conditional writes", () => {
    test("If-None-Match: * creates once", async () => {
      const k = key("create");
      await bucket.put(k, "1", { ifNoneMatch: "*" });
      await expect(bucket.put(k, "2", { ifNoneMatch: "*" })).rejects.toThrow(PreconditionFailed);
    });

    test("If-Match takes the current etag and refuses a stale one", async () => {
      const k = key("update");
      const first = await bucket.put(k, "1");
      const second = await bucket.put(k, "2", { ifMatch: first.etag });
      await expect(bucket.put(k, "3", { ifMatch: first.etag })).rejects.toThrow(PreconditionFailed);
      await bucket.put(k, "4", { ifMatch: second.etag });
    });

    test("If-Match on a missing key is a failed condition and writes nothing", async () => {
      const k = key("missing");
      await expect(bucket.put(k, "1", { ifMatch: "abc" })).rejects.toThrow(PreconditionFailed);
      expect(await bucket.head(k)).toBeNull();
    });

    test("ten racing creates: one wins", async () => {
      const k = key("race");
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => bucket.put(k, String(i), { ifNoneMatch: "*" })),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });

    test("delete with a wrong etag is refused and keeps the object", async () => {
      const k = key("delete");
      const { etag } = await bucket.put(k, "1");
      await expect(bucket.delete(k, { ifMatch: "0000" })).rejects.toThrow(PreconditionFailed);
      expect(await bucket.head(k)).not.toBeNull();
      await bucket.delete(k, { ifMatch: etag });
      expect(await bucket.head(k)).toBeNull();
    });
  });

  describe("presigned URLs", () => {
    const options = { contentType: "text/plain", contentLength: 5, cacheControl: IMMUTABLE };

    test("a PUT works with its headers, and the object keeps them", async () => {
      time = new Date();
      const k = key("put");
      const { url, headers } = await bucket.presignPut(k, options);
      const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
      for (const header of ["content-type", "content-length", "cache-control"])
        expect(signed).toContain(header);
      expect(new URL(url).searchParams.get("x-amz-checksum-crc32")).toBeNull();

      const response = await fetch(url, { method: "PUT", body: "hello", headers });
      expect(response.status).toBe(200);
      expect(await bucket.head(k)).toMatchObject({
        contentType: "text/plain",
        cacheControl: IMMUTABLE,
        size: 5,
      });
    });

    test("a PUT with another type or length is refused", async () => {
      time = new Date();
      const k = key("put");
      const { url, headers } = await bucket.presignPut(k, options);
      const wrongType = await fetch(url, {
        method: "PUT",
        body: "hello",
        headers: { ...headers, "Content-Type": "text/html" },
      });
      const wrongLength = await fetch(url, { method: "PUT", body: "hello!", headers });
      expect(wrongType.ok).toBe(false);
      expect(wrongLength.ok).toBe(false);
      expect(await bucket.head(k)).toBeNull();
    });

    test("a GET is the same URL all day, changes the next day, and works", async () => {
      const k = key("get");
      await bucket.put(k, "hello", { cacheControl: IMMUTABLE });
      const at = (iso: string) => {
        time = new Date(iso);
        return bucket.presignGet(k);
      };
      const today = new Date().toISOString().slice(0, 10);
      const morning = await at(`${today}T00:00:01Z`);
      const evening = await at(`${today}T23:59:59Z`);
      expect(morning).toBe(evening);
      const tomorrow = new Date(Date.parse(today) + 24 * 3600 * 1000 + 1000).toISOString();
      expect(await at(tomorrow)).not.toBe(morning);

      const response = await fetch(morning);
      expect(await response.text()).toBe("hello");
      expect(response.headers.get("cache-control")).toContain("immutable");
    });

    test("a GET can override the type and force a download", async () => {
      time = new Date();
      const k = key("file");
      await bucket.put(k, "<script>");
      const url = await bucket.presignGet(k, {
        responseContentType: "text/plain",
        responseContentDisposition: "attachment",
      });
      const response = await fetch(url);
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(response.headers.get("content-disposition")).toBe("attachment");
    });
  });

  test("bucketOrigin follows the URL style", () => {
    const base = { ...config, publicEndpoint: "https://t3.storageapi.dev", bucket: "b" };
    expect(bucketOrigin({ ...base, forcePathStyle: true })).toBe("https://t3.storageapi.dev");
    expect(bucketOrigin({ ...base, forcePathStyle: false })).toBe("https://b.t3.storageapi.dev");
  });
});
