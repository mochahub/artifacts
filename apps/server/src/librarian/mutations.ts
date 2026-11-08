import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/index.ts";
import { librarianReceipts } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { type RunFence, withRunFence } from "./leases.ts";

/** All content services invoked here MUST use this tx, including locks, policy and activity.
 * A service opening its own transaction cannot participate in this atomic guarantee. */
export async function withToolReceipt<T>(
  deps: Deps,
  fence: RunFence,
  input: { toolKey: string; inputHash: string },
  mutate: (tx: Tx) => Promise<T>,
  authorize: (tx: Tx) => Promise<void>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(input.inputHash)) throw new ApiError("invalid", "Invalid input hash.");
  return withRunFence(deps, fence, async (tx) => {
    await authorize(tx);
    const [prior] = await tx
      .select()
      .from(librarianReceipts)
      .where(
        and(
          eq(librarianReceipts.runId, fence.runId),
          eq(librarianReceipts.toolKey, input.toolKey),
          eq(librarianReceipts.orgId, fence.orgId),
        ),
      );
    if (prior) {
      if (prior.inputHash !== input.inputHash) throw new ApiError("conflict", "Tool input changed.");
      return prior.result as T;
    }
    const result = await mutate(tx);
    const encoded = JSON.stringify(result);
    if (encoded === undefined || Buffer.byteLength(encoded) > 60_000)
      throw new ApiError("invalid", "Tool result exceeds receipt limit.");
    await tx.insert(librarianReceipts).values({
      id: crypto.randomUUID(),
      orgId: fence.orgId,
      runId: fence.runId,
      toolKey: input.toolKey,
      inputHash: input.inputHash,
      result: JSON.parse(encoded),
      createdAt: deps.clock.now(),
    });
    return result;
  });
}
