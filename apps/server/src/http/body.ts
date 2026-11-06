import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors.ts";

/** Parses a JSON body with the schema from packages/schema (01). */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("invalid", "The body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("invalid", "The request isn't valid.", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * Reads a request body without taking more than `limit` bytes, whether or not it declares a length. Bun
 * would otherwise buffer up to 128 MB of a chunked body before anyone could say no.
 */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw tooBig(limit);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of (request.body ?? []) as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw tooBig(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const tooBig = (limit: number) => new ApiError("too_large", "That request is too big.", { limit });
