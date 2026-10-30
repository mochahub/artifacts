import { createHmac } from "node:crypto";
import { isDataKey } from "@artifacts/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import type { Caller } from "../auth/caller.ts";
import type { OrgRow } from "../db/index.ts";
import { artifactUsage } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { PreconditionFailed } from "../s3.ts";

type Limits = OrgRow["settings"]["limits"];
export type Scope = "shared" | "me";
type UsageScope = Scope | "files";

export function checkKey(key: string): string {
  if (!isDataKey(key)) {
    throw new ApiError("invalid", "Keys are up to 200 characters of letters, digits and ._/-");
  }
  return key;
}

/** The per-artifact id a person or guest has here; backends see the same one (08). */
export function pseudonym(org: OrgRow, artifactId: string, personOrGuestId: string): string {
  const digest = createHmac("sha256", Buffer.from(org.pseudonymKey))
    .update(`${artifactId}:${personOrGuestId}`)
    .digest()
    .subarray(0, 16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += "abcdefghijklmnopqrstuvwxyz234567"[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export const callerKey = (caller: Caller): string | null => {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person.id;
  if (caller.kind === "guest") return caller.guestId;
  if (caller.kind === "content") return caller.caller.id;
  return null;
};

export const dataPrefix = (artifactId: string) => `data/${artifactId}/`;

/** Where a scope lives. `me` needs the caller's pseudonym; nobody reads another person's space here. */
export function scopePath(artifactId: string, scope: Scope, me: string | null, files = false) {
  const base = `${dataPrefix(artifactId)}${files ? "files/" : ""}`;
  if (scope === "shared") return `${base}shared/`;
  if (!me) throw new ApiError("forbidden", "Only a person or a named guest has a personal space.");
  return `${base}me/${me}/`;
}

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];

/** The row lock in 08: writes to one artifact's scope run one at a time. */
async function withUsage<T>(
  deps: Deps,
  orgId: string,
  artifactId: string,
  scope: UsageScope,
  work: (
    tx: Tx,
    usage: { keys: number; bytes: number },
  ) => Promise<{ value: T; keys: number; bytes: number }>,
) {
  return deps.db.transaction(async (tx) => {
    await tx
      .insert(artifactUsage)
      .values({ artifactId, scope, orgId, keys: 0, bytes: 0, updatedAt: deps.clock.now() })
      .onConflictDoNothing();
    const [usage] = await tx
      .select()
      .from(artifactUsage)
      .where(and(eq(artifactUsage.artifactId, artifactId), eq(artifactUsage.scope, scope)))
      .for("update");
    const result = await work(tx, { keys: usage?.keys ?? 0, bytes: usage?.bytes ?? 0 });
    await tx
      .update(artifactUsage)
      .set({
        keys: sql`greatest(${artifactUsage.keys} + ${result.keys}, 0)`,
        bytes: sql`greatest(${artifactUsage.bytes} + ${result.bytes}, 0)`,
        updatedAt: deps.clock.now(),
      })
      .where(and(eq(artifactUsage.artifactId, artifactId), eq(artifactUsage.scope, scope)));
    return result.value;
  });
}

const tooLarge = (limit: number) =>
  new ApiError("too_large", "That's over the limit for saved data.", { limit });

export async function putValue(
  deps: Deps,
  options: {
    orgId: string;
    artifactId: string;
    scope: UsageScope;
    objectKey: string;
    value: unknown;
    limits: Limits;
    ifMatch?: string;
    ifNoneMatch?: boolean;
  },
) {
  const body = JSON.stringify(options.value);
  const size = Buffer.byteLength(body);
  if (size > options.limits.dataValueBytes) throw tooLarge(options.limits.dataValueBytes);
  return withUsage(deps, options.orgId, options.artifactId, options.scope, async (_tx, usage) => {
    const head = await deps.bucket.head(options.objectKey);
    if (options.ifMatch && !head) throw new PreconditionFailed("The value changed.");
    const newKeys = head ? 0 : 1;
    const delta = size - (head?.size ?? 0);
    if (usage.keys + newKeys > options.limits.dataKeysPerScope)
      throw tooLarge(options.limits.dataKeysPerScope);
    if (usage.bytes + delta > options.limits.dataBytesPerScope)
      throw tooLarge(options.limits.dataBytesPerScope);
    const { etag } = await deps.bucket.put(options.objectKey, body, {
      contentType: "application/json",
      ifMatch: options.ifMatch,
      ifNoneMatch: options.ifNoneMatch ? "*" : undefined,
    });
    return { value: { etag }, keys: newKeys, bytes: delta };
  });
}

export async function deleteValue(
  deps: Deps,
  options: { orgId: string; artifactId: string; scope: UsageScope; objectKey: string; ifMatch?: string },
) {
  return withUsage(deps, options.orgId, options.artifactId, options.scope, async (_tx) => {
    const head = await deps.bucket.head(options.objectKey);
    if (!head) {
      if (options.ifMatch) throw new PreconditionFailed("The value changed.");
      throw new ApiError("not_found", "Not found.");
    }
    await deps.bucket.delete(options.objectKey, { ifMatch: options.ifMatch });
    return { value: undefined, keys: -1, bytes: -head.size };
  });
}

export async function putFile(
  deps: Deps,
  options: {
    orgId: string;
    artifactId: string;
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    limits: Limits;
  },
) {
  const size = options.body.length;
  if (size > options.limits.fileBytes) throw tooLarge(options.limits.fileBytes);
  return withUsage(deps, options.orgId, options.artifactId, "files", async (_tx, usage) => {
    const head = await deps.bucket.head(options.objectKey);
    const delta = size - (head?.size ?? 0);
    if (usage.bytes + delta > options.limits.filesBytesPerArtifact) {
      throw tooLarge(options.limits.filesBytesPerArtifact);
    }
    const { etag } = await deps.bucket.put(options.objectKey, options.body, {
      contentType: options.contentType,
    });
    return { value: { etag, size }, keys: head ? 0 : 1, bytes: delta };
  });
}

const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|(audio|video)\/[a-z0-9.+-]+|application\/pdf)$/;

/**
 * The type to open a file in place with, or null to download it, so an uploaded page can't run as a
 * page (08). A list of what's safe: SVG is an image that can carry script.
 */
export const inlineType = (type: string) => {
  const essence = (type.split(";")[0] as string).trim().toLowerCase();
  return INLINE.test(essence) ? essence : null;
};

export async function fileUrl(deps: Deps, objectKey: string) {
  const head = await deps.bucket.head(objectKey);
  if (!head) throw new ApiError("not_found", "Not found.");
  const inline = inlineType(head.contentType ?? "");
  return deps.bucket.presignGet(objectKey, {
    responseContentType: inline ?? "application/octet-stream",
    responseContentDisposition: inline ? undefined : "attachment",
  });
}

export async function listKeys(deps: Deps, prefix: string, cursor?: string) {
  const page = await deps.bucket.list(prefix, { cursor });
  return {
    keys: page.objects.map((object) => ({
      key: object.key.slice(prefix.length),
      etag: object.etag,
      size: object.size,
      updatedAt: object.updatedAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

/** Every object under a prefix. */
export async function walk(deps: Deps, prefix: string) {
  const all: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list(prefix, { cursor });
    all.push(...page.objects);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

/** What's really stored, for the daily recount (08). */
export async function recountUsage(deps: Deps, orgId: string, artifactId: string) {
  const prefix = dataPrefix(artifactId);
  const objects = await walk(deps, prefix);
  const tally = (match: (key: string) => boolean) => {
    const rows = objects.filter((object) => match(object.key.slice(prefix.length)));
    return { keys: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) };
  };
  const scopes = {
    shared: tally((key) => key.startsWith("shared/")),
    me: tally((key) => key.startsWith("me/")),
    files: tally((key) => key.startsWith("files/")),
  };
  for (const [scope, { keys, bytes }] of Object.entries(scopes)) {
    await deps.db
      .insert(artifactUsage)
      .values({ artifactId, scope, orgId, keys, bytes, updatedAt: deps.clock.now() })
      .onConflictDoUpdate({
        target: [artifactUsage.artifactId, artifactUsage.scope],
        set: { keys, bytes, updatedAt: deps.clock.now() },
      });
  }
}
