import { join, resolve, sep } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import type { Deps } from "../api/deps.ts";
import type { Env } from "../env.ts";
import { ApiError } from "./errors.ts";
import { unfurl } from "./unfurl.ts";

/** Response headers from 04, "CSRF, hosts and headers". */
export function viewerHeaders(env: Env, bucket: string): MiddlewareHandler {
  const csp = [
    "default-src 'self'",
    ...(env.contentUrl ? [`frame-src ${env.contentUrl}`] : []),
    `img-src 'self' data: blob: ${bucket}`,
    `media-src 'self' ${bucket}`,
    "connect-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", csp);
    c.header("Strict-Transport-Security", "max-age=31536000");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
  };
}

/**
 * Accepts only viewer hosts (421 otherwise). `homeDomain` is read lazily: it's in Postgres, and most
 * requests match PUBLIC_URL or MORE_URLS without touching it.
 */
export function requireViewerHost(env: Env, homeDomain: () => Promise<string | null>): MiddlewareHandler {
  const hosts = new Set(env.viewerOrigins.map((origin) => new URL(origin).host));
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase() ?? "";
    if (!hosts.has(host) && host.split(":")[0] !== (await homeDomain())) {
      throw new ApiError("misdirected", "This server doesn't answer on that host.");
    }
    await next();
  };
}

/** Serves the built viewer: hashed assets forever, and index.html for every client-side route. */
export function serveViewer(dir: string | null, deps: Deps) {
  const root = dir && resolve(dir);
  const file = (path: string, cacheControl: string) =>
    new Response(Bun.file(path), { headers: { "Cache-Control": cacheControl } });

  return async (c: Context) => {
    if (!root) throw new ApiError("not_found", "The viewer isn't built.");
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      throw new ApiError("not_found", "Not found.");
    }
    // A NUL byte makes the file system call throw, and no file has one in its name.
    if (path.includes("\0")) throw new ApiError("not_found", "Not found.");
    const target = resolve(root, `.${path}`);
    const immutable = path.startsWith("/assets/");
    if (target.startsWith(root + sep) && (await Bun.file(target).exists())) {
      return file(target, immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }
    if (immutable) throw new ApiError("not_found", "Not found.");
    const html = await Bun.file(join(root, "index.html")).text();
    return c.html(await unfurl(c, deps, html), 200, { "Cache-Control": "no-cache" });
  };
}
