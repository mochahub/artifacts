import {
  BOARDS_FEATURE,
  EDITING_ACTIVITY_FALLBACK,
  EDITING_FEATURE,
  FEATURES_HEADER,
} from "@artifacts/schema";
import type { Context } from "hono";

/**
 * Released CLIs parse a few shapes with strict enums, so they can't read `edit` or the editing log kinds
 * (13, "Older clients"). A request that says it's the CLI and doesn't list the `editing` feature gets
 * those answers rewritten: `edit` reads `comment`, `checkpointed` reads `published`, and the other new
 * log kinds are left out. The viewer and the hosted MCP always get the real values.
 */
const REWRITTEN = [
  /^\/api\/wikis\/[^/]+$/,
  /^\/api\/projects\/[^/]+\/access$/,
  /^\/api\/teams\/[^/]+$/,
  /^\/api\/artifacts\/[^/]+\/access$/,
];
const LEVEL_KEYS = new Set(["permission", "level", "projectPermission"]);
const FALLBACK = EDITING_ACTIVITY_FALLBACK as Record<string, string | null>;

const featuresOf = (c: Context) =>
  (c.req.header(FEATURES_HEADER) ?? "").split(",").map((word) => word.trim());

export const olderClient = (c: Context) => {
  if (!c.req.header("artifacts-cli")) return false;
  return !featuresOf(c).includes(EDITING_FEATURE);
};

/**
 * A CLI without the `boards` feature can't parse an object anchor (14, "CLI and skill"): its threads come
 * back with `anchor: null`, keeping their number, state and crop. The viewer and hosted MCP see them all.
 */
export const boardlessClient = (c: Context) =>
  Boolean(c.req.header("artifacts-cli")) && !featuresOf(c).includes(BOARDS_FEATURE);
const THREADED = [
  /^\/api\/artifacts\/[^/]+\/threads$/,
  /^\/api\/threads\/[^/]+\/[a-z]+$/,
  /^\/api\/review\//,
];

/** Object anchors as `null`, anywhere in an answer. Pure, like `downgrade`. */
export function hideObjectAnchors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideObjectAnchors);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "anchor" && item && typeof item === "object" && (item as { type?: unknown }).type === "object"
          ? null
          : hideObjectAnchors(item),
      ]),
    );
  }
  return value;
}

/** Rewrites a thread answer in place for a CLI without the boards feature. */
export async function rewriteBoardAnchors(c: Context) {
  if (!THREADED.some((pattern) => pattern.test(c.req.path))) return;
  const res = c.res;
  if (!res.headers.get("content-type")?.includes("application/json")) return;
  const text = await res.clone().text();
  if (!text.includes('"object"')) return;
  const headers = new Headers(res.headers);
  headers.delete("etag");
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(hideObjectAnchors(JSON.parse(text))), { status: res.status, headers });
}

/** The answer as a released CLI can parse it. Pure, so the compat test runs it on fixtures. */
export function downgrade(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (
        item &&
        typeof item === "object" &&
        "kind" in item &&
        typeof item.kind === "string" &&
        item.kind in FALLBACK
      ) {
        const kind = FALLBACK[item.kind];
        return kind ? [downgrade({ ...item, kind })] : [];
      }
      return [downgrade(item)];
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        LEVEL_KEYS.has(key) && item === "edit" ? "comment" : downgrade(item),
      ]),
    );
  }
  return value;
}

/** Rewrites `c.res` in place for an older CLI, on the four answers it parses strictly. */
export async function rewriteForOlderClient(c: Context) {
  if (c.req.method !== "GET" || !REWRITTEN.some((pattern) => pattern.test(c.req.path))) return;
  const res = c.res;
  if (res.status !== 200 || !res.headers.get("content-type")?.includes("application/json")) return;
  const body = downgrade(await res.clone().json());
  const headers = new Headers(res.headers);
  // The tag is the real answer's; this one differs, so it isn't cached as that.
  headers.delete("etag");
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(body), { status: res.status, headers });
}
