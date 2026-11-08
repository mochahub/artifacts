import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/index.ts";
import { lockLibrarian } from "../../db/locks.ts";
import { librarianReceipts } from "../../db/schema.ts";
import type { Deps } from "../../deps.ts";
import {
  type Preparation,
  PreparationRequired,
  preparation,
  registerAfterCommit,
} from "../../editing/transaction.ts";
import type { RunFence } from "../index.ts";
import { guard } from "../leases.ts";
import { subscribeRunCancellation } from "../signals.ts";
/** Caller serializes the receipt identity and checks the durable fence before commit. */
export async function withToolReceipt(
  tx: Tx,
  fence: RunFence,
  key: { id: string; inputHash: string },
  maxBytes: number,
  use: () => Promise<unknown>,
): Promise<unknown> {
  const [existing] = await tx
    .select()
    .from(librarianReceipts)
    .where(
      and(
        eq(librarianReceipts.orgId, fence.orgId),
        eq(librarianReceipts.runId, fence.runId),
        eq(librarianReceipts.toolKey, key.id),
      ),
    );
  if (existing) {
    if (existing.inputHash !== key.inputHash) throw new Error("receipt_conflict");
    if (Buffer.byteLength(JSON.stringify(existing.result)) > maxBytes) throw new Error("result_limit");
    return existing.result;
  }
  const result = await use();
  const encoded = JSON.stringify(result);
  if (encoded === undefined || Buffer.byteLength(encoded) > Math.min(maxBytes, 60000))
    throw new Error("result_limit");
  await tx.insert(librarianReceipts).values({
    id: crypto.randomUUID(),
    orgId: fence.orgId,
    runId: fence.runId,
    toolKey: key.id,
    inputHash: key.inputHash,
    result,
  });
  return result;
}

/** A cache miss unwinds the DB transaction before touching storage. Each subsequent
 * pass compares the original authorized content snapshot; only a DB-only pass commits.
 * Staged immutable hashes are left to grace-period GC on refusal/cancellation.
 */
export async function prepareAndPersist<T>(
  deps: Deps,
  fence: RunFence,
  key: string,
  prepare: (tx: Tx) => Promise<T>,
  recheck?: (tx: Tx) => Promise<void>,
): Promise<T> {
  const cache = new Map<string, unknown>();
  const bucket = new Proxy({} as Deps["bucket"], {
    get(_target, method: string) {
      return (...args: unknown[]) => {
        if (method !== "get" && method !== "put") throw new Error("Unsupported staged storage operation.");
        const identity = JSON.stringify([method, ...args]);
        if (cache.has(identity)) return Promise.resolve(cache.get(identity));
        throw new PreparationRequired(async () => {
          const fn = deps.bucket[method] as (...args: unknown[]) => Promise<unknown>;
          cache.set(identity, await fn.apply(deps.bucket, args));
        });
      };
    },
  });
  const state: Preparation = {
    snapshots: new Map(),
    seen: new Set(),
    ids: [],
    index: 0,
    bucket,
    now: deps.clock.now(),
    limits: new Set(),
    computed: new Map(),
  };
  const cancellation = await subscribeRunCancellation(deps, fence, 50);
  const deadline = AbortSignal.timeout(15000);
  const signal = AbortSignal.any([cancellation.signal, deadline]);
  const bounded = async <V>(use: () => Promise<V>): Promise<V> => {
    signal.throwIfAborted();
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error("Content preparation aborted."));
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      return await Promise.race([use(), aborted]);
    } finally {
      signal.removeEventListener("abort", rejectAbort);
    }
  };
  try {
    for (let pass = 0; pass < 100; pass++) {
      signal.throwIfAborted();
      state.seen.clear();
      state.index = 0;
      const queued: (() => void)[] = [];
      try {
        const result = await preparation.run(state, () =>
          deps.db.transaction(async (tx) => {
            registerAfterCommit(tx, queued);
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`librarian-tool:${fence.runId}:${key}`}, 0))`,
            );
            await guard(deps, tx, fence);
            const result = await prepare(tx);
            await lockLibrarian(tx, fence.orgId);
            await guard(deps, tx, fence);
            await recheck?.(tx);
            signal.throwIfAborted();
            return result;
          }),
        );
        for (const fn of queued) fn();
        return result;
      } catch (error) {
        // Drizzle may attach the original adapter exception as a cause.
        let cause = error;
        while (cause instanceof Error && !(cause instanceof PreparationRequired) && cause.cause)
          cause = cause.cause;
        if (!(cause instanceof PreparationRequired)) throw error;
        await bounded(cause.perform);
      }
    }
    throw new Error("Content preparation exceeded storage operation limit.");
  } finally {
    await cancellation.close();
  }
}
