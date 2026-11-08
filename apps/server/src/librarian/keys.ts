import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { librarianKeys } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import type { RunFence } from "./leases.ts";
import { locked, withRunFence } from "./leases.ts";

export type KeyEnvelope = typeof librarianKeys.$inferSelect.envelope;
export type Keyring = { active: string; keys: ReadonlyMap<string, Buffer> };
const fail = () => new Error("Librarian credential unavailable");
export function keyring(deps: Pick<Deps, "env">): Keyring {
  try {
    const active = deps.env.librarianKekId;
    const values: unknown = JSON.parse(deps.env.librarianKekRing ?? "{}");
    if (!active || !values || typeof values !== "object" || Array.isArray(values)) throw fail();
    const keys = new Map<string, Buffer>();
    for (const [id, value] of Object.entries(values)) {
      if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw fail();
      const bytes = Buffer.from(value, "base64");
      if (bytes.length !== 32) throw fail();
      keys.set(id, bytes);
    }
    if (!keys.has(active)) throw fail();
    return { active, keys };
  } catch {
    throw fail();
  }
}
const aad = (orgId: string, generation: number, purpose: string) =>
  Buffer.from(JSON.stringify([orgId, "librarian-provider", generation, purpose]));
function seal(value: Buffer, key: Buffer, context: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function open(value: { ciphertext: string; nonce: string; tag: string }, key: Buffer, context: Buffer) {
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64"));
  cipher.setAAD(context);
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(value.ciphertext, "base64")), cipher.final()]);
}
export function encryptProviderKey(
  value: Buffer,
  orgId: string,
  generation: number,
  ring: Keyring,
): KeyEnvelope {
  const data = randomBytes(32);
  try {
    const encrypted = seal(value, data, aad(orgId, generation, "credential"));
    const kek = ring.keys.get(ring.active);
    if (!kek) throw fail();
    const wrap = seal(data, kek, aad(orgId, generation, "data-key"));
    return {
      ...encrypted,
      kekId: ring.active,
      wrappedKey: wrap.ciphertext,
      wrapNonce: wrap.nonce,
      wrapTag: wrap.tag,
    };
  } finally {
    data.fill(0);
  }
}
export function decryptProviderKey(
  envelope: KeyEnvelope,
  orgId: string,
  generation: number,
  ring: Keyring,
): Buffer {
  let data: Buffer | undefined;
  try {
    const kek = ring.keys.get(envelope.kekId);
    if (!kek) throw fail();
    data = open(
      { ciphertext: envelope.wrappedKey, nonce: envelope.wrapNonce, tag: envelope.wrapTag },
      kek,
      aad(orgId, generation, "data-key"),
    );
    return open(envelope, data, aad(orgId, generation, "credential"));
  } catch {
    throw fail();
  } finally {
    data?.fill(0);
  }
}
/** Re-encrypts with fresh data key/nonces; caller persists transactionally before retiring any KEK. */
export function rotateEnvelope(
  envelope: KeyEnvelope,
  orgId: string,
  generation: number,
  ring: Keyring,
): KeyEnvelope {
  const value = decryptProviderKey(envelope, orgId, generation, ring);
  try {
    const next = encryptProviderKey(value, orgId, generation, ring);
    const verified = decryptProviderKey(next, orgId, generation, ring);
    try {
      if (!verified.equals(value)) throw fail();
    } finally {
      verified.fill(0);
    }
    return next;
  } finally {
    value.fill(0);
  }
}
/** Only trusted provider adapters may call this. No transaction spans provider I/O. */
export async function withProviderKey<T>(
  deps: Deps,
  fence: RunFence,
  use: (key: Buffer) => Promise<T>,
): Promise<T> {
  const row = await withRunFence(deps, fence, async (tx) => {
    const [row] = await tx.select().from(librarianKeys).where(eq(librarianKeys.orgId, fence.orgId));
    if (!row) throw fail();
    return row;
  });
  const value = decryptProviderKey(row.envelope, fence.orgId, row.generation, keyring(deps));
  try {
    return await use(value);
  } finally {
    value.fill(0);
  }
}

/** Trusted deployment operation. Keep previous KEKs available throughout backup retention. */
export async function rotateAllProviderEnvelopes(deps: Deps): Promise<number> {
  const ring = keyring(deps);
  const rows = await deps.db.select({ orgId: librarianKeys.orgId }).from(librarianKeys);
  let count = 0;
  for (const { orgId } of rows)
    await locked(deps, orgId, async (tx) => {
      const [row] = await tx.select().from(librarianKeys).where(eq(librarianKeys.orgId, orgId));
      if (!row || row.envelope.kekId === ring.active) return;
      const envelope = rotateEnvelope(row.envelope, orgId, row.generation, ring);
      await tx
        .update(librarianKeys)
        .set({ envelope, updatedAt: deps.clock.now() })
        .where(eq(librarianKeys.orgId, orgId));
      count++;
    });
  return count;
}
