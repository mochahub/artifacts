import { createHash } from "node:crypto";
import type { Context } from "hono";

/** List and detail GETs answer 304 when nothing changed, which is what MVP polling leans on (03). */
export function etagJson(c: Context, body: unknown) {
  const text = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(text).digest("base64url").slice(0, 22)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  // It may be a list, and a proxy that compresses the answer turns the tag weak (W/).
  const sent = (c.req.header("if-none-match") ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
  if (sent.includes(etag) || sent.includes("*")) return c.body(null, 304);
  return c.body(text, 200, { "Content-Type": "application/json; charset=utf-8" });
}
