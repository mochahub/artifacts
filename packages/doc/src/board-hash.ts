import { createHash } from "node:crypto";
import type { BoardObject, BoardSnapshot } from "@artifacts/schema/boards";
import { canonicalJSON } from "./board.ts";

/**
 * Server-side hashing over the shared canonicalizer (14, "Objects and stable ids"). The browser model
 * never needs these; it can hash `canonicalJSON` itself with Web Crypto.
 */
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The authored fields a base covers: everything visible except attribution; a connector's pose is derived. */
export function baseFields(object: BoardObject): Record<string, unknown> {
  const { attribution: _attribution, ...rest } = object;
  if (object.kind === "connector") {
    const { pose: _pose, ...noPose } = rest as typeof rest & { pose: unknown };
    return noPose;
  }
  return rest;
}

/** An object's operation base: 12 hex digits of SHA-256 of its canonical authored fields. */
export const boardBase = (object: BoardObject) => sha256(canonicalJSON(baseFields(object))).slice(0, 12);

/**
 * A native comment anchor's content hash: kind, text, label, style and kind data, without pose, parent,
 * order or attribution, so moving, grouping or reordering keeps a pin `ok`.
 */
export function boardContentHash(object: BoardObject): string {
  const { attribution: _a, pose: _p, parent: _parent, order: _o, ...content } = object;
  return sha256(canonicalJSON(content));
}

/** The full snapshot hash, attribution, tombstones and asset metadata included. */
export function boardHash(snapshot: BoardSnapshot): string {
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return sha256(
    canonicalJSON({
      ...snapshot,
      objects: [...snapshot.objects].sort(byId),
      deleted: [...(snapshot.deleted ?? [])].sort(byId),
      assets: [...snapshot.assets].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)),
    }),
  );
}

export { canonicalJSON };
