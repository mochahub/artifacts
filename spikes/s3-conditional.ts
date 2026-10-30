// Spike S3: conditional writes and presigned URLs against an S3-compatible endpoint.
// Usage: S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_BUCKET=spike bun s3-conditional.ts
// Run against Railway's bucket by setting the same variables from `railway variable list`.
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const env = process.env;
const bucket = env.S3_BUCKET ?? "spike";
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION ?? "auto",
  forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  // The SDK's default embeds a CRC32 of an empty body in presigned PUTs; SeaweedFS rejects those (BadDigest).
  requestChecksumCalculation: env.S3_CHECKSUMS === "default" ? undefined : "WHEN_REQUIRED",
  responseChecksumValidation: env.S3_CHECKSUMS === "default" ? undefined : "WHEN_REQUIRED",
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
});

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; status?: number; name?: string }> {
  try {
    return { ok: true, v: await fn() };
  } catch (e) {
    return { ok: false, status: status(e), name: (e as Error).name };
  }
}
const put = (Key: string, Body: string, extra: Record<string, string> = {}) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType: "application/json", ...extra }));

if (env.S3_CREATE_BUCKET !== "false") await attempt(() => s3.send(new CreateBucketCommand({ Bucket: bucket })));
const run = `spike-${Date.now()}`;

// 1. If-None-Match: * (create only)
{
  const key = `${run}/create-only`;
  const a = await attempt(() => put(key, '{"v":1}', { IfNoneMatch: "*" }));
  check("If-None-Match:* on a new key succeeds", a.ok, a.ok ? "" : `${a.status} ${a.name}`);
  const b = await attempt(() => put(key, '{"v":2}', { IfNoneMatch: "*" }));
  check("If-None-Match:* on an existing key → 412", !b.ok && b.status === 412, b.ok ? "write succeeded" : `${b.status} ${b.name}`);
}

// 2. If-Match
{
  const key = `${run}/if-match`;
  const first = await put(key, '{"v":1}');
  const etag = first.ETag!; // quoted, e.g. "\"abc\""
  const unquoted = etag.replaceAll('"', "");
  const ok1 = await attempt(() => put(key, '{"v":2}', { IfMatch: etag }));
  check("If-Match with the current (quoted) ETag succeeds", ok1.ok, ok1.ok ? "" : `${ok1.status} ${ok1.name}`);
  const stale = await attempt(() => put(key, '{"v":3}', { IfMatch: etag }));
  check("If-Match with a stale ETag → 412", !stale.ok && stale.status === 412, stale.ok ? "write succeeded" : `${stale.status} ${stale.name}`);
  const cur = (ok1.ok ? ok1.v.ETag : etag)!.replaceAll('"', "");
  const ok2 = await attempt(() => put(key, '{"v":4}', { IfMatch: cur }));
  check("If-Match with the current ETag unquoted succeeds", ok2.ok, ok2.ok ? "" : `${ok2.status} ${ok2.name}`);
  const missing = await attempt(() => put(`${run}/never-written`, "{}", { IfMatch: unquoted }));
  check("If-Match on a missing key fails (404 or 412)", !missing.ok && [404, 412].includes(missing.status!), missing.ok ? "write succeeded" : `${missing.status} ${missing.name}`);
}

// 3. Concurrency: 10 racing creates, 10 racing updates from the same ETag
{
  const key = `${run}/race-create`;
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(() => put(key, `{"w":${i}}`, { IfNoneMatch: "*" }))));
  const wins = rs.filter((r) => r.ok).length;
  const codes = [...new Set(rs.filter((r) => !r.ok).map((r) => (r as { status?: number }).status))];
  check("10 concurrent creates → exactly 1 wins", wins === 1, `wins=${wins} losers=${codes.join(",")}`);

  const key2 = `${run}/race-update`;
  const base = await put(key2, '{"n":0}');
  const rs2 = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(() => put(key2, `{"n":${i + 1}}`, { IfMatch: base.ETag! }))));
  const wins2 = rs2.filter((r) => r.ok).length;
  const codes2 = [...new Set(rs2.filter((r) => !r.ok).map((r) => (r as { status?: number }).status))];
  check("10 concurrent If-Match updates → exactly 1 wins", wins2 === 1, `wins=${wins2} losers=${codes2.join(",")}`);
}

// 4. Conditional delete
{
  const key = `${run}/delete`;
  const p = await put(key, "{}");
  const bad = await attempt(() => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: '"0000"' })));
  const still = await attempt(() => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
  check("DeleteObject with a wrong If-Match is refused", !bad.ok || still.ok === true, bad.ok ? (still.ok ? "accepted but object kept" : "deleted anyway") : `${bad.status} ${bad.name}`);
  const good = await attempt(() => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: p.ETag })));
  check("DeleteObject with the right If-Match succeeds", good.ok, good.ok ? "" : `${good.status} ${good.name}`);
}

// 5. Presigned PUT with signed Content-Type, Content-Length and Cache-Control
{
  const key = `blobs/${run}-presigned`;
  const body = new TextEncoder().encode("hello presigned");
  const cmd = new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: "text/plain", ContentLength: body.length,
    CacheControl: "public, max-age=31536000, immutable",
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900, signableHeaders: new Set(["content-type", "content-length", "cache-control"]) });
  const signed = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
  check("Presigned PUT signs content-type, content-length, cache-control", ["content-type", "content-length", "cache-control"].every((h) => signed.includes(h)), signed);
  const r = await fetch(url, { method: "PUT", body, headers: { "content-type": "text/plain", "cache-control": "public, max-age=31536000, immutable" } });
  check("Presigned PUT upload succeeds", r.ok, `${r.status}`);
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  check("Stored object keeps Cache-Control", head.CacheControl === "public, max-age=31536000, immutable", String(head.CacheControl));
  check("Stored object keeps Content-Type", head.ContentType === "text/plain", String(head.ContentType));
  const wrongType = await fetch(url, { method: "PUT", body, headers: { "content-type": "text/html", "cache-control": "public, max-age=31536000, immutable" } });
  check("Presigned PUT with a different Content-Type is refused", !wrongType.ok, `${wrongType.status}`);
  const wrongLen = await fetch(url, { method: "PUT", body: new TextEncoder().encode("hello presigned, longer"), headers: { "content-type": "text/plain", "cache-control": "public, max-age=31536000, immutable" } });
  check("Presigned PUT with a different length is refused", !wrongLen.ok, `${wrongLen.status}`);

  // 6. Presigned GET, signed per UTC day
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const sign = (extra: Record<string, string> = {}) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ...extra }), { expiresIn: 26 * 3600, signingDate: day });
  const u1 = await sign();
  await Bun.sleep(1100);
  const u2 = await sign();
  check("Presigned GET URLs signed with the day's date are identical", u1 === u2);
  const g = await fetch(u1);
  check("Presigned GET (signed at 00:00 UTC, 26 h expiry) works now", g.ok, `${g.status}`);
  check("GET returns Cache-Control immutable", (g.headers.get("cache-control") ?? "").includes("immutable"), String(g.headers.get("cache-control")));
  const u3 = await sign({ ResponseContentType: "application/pdf", ResponseContentDisposition: "attachment" });
  const g3 = await fetch(u3);
  check("response-content-type override", g3.headers.get("content-type") === "application/pdf", String(g3.headers.get("content-type")));
  check("response-content-disposition override", g3.headers.get("content-disposition") === "attachment", String(g3.headers.get("content-disposition")));
  const etagGet = await fetch(u1, { headers: { "if-none-match": g.headers.get("etag") ?? "" } });
  check("Conditional GET with If-None-Match → 304", etagGet.status === 304, `${etagGet.status}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed against ${env.S3_ENDPOINT}`);
if (env.S3_RESULT_JSON) await Bun.write(env.S3_RESULT_JSON, JSON.stringify(results, null, 2));
