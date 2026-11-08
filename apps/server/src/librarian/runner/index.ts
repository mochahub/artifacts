import { eq } from "drizzle-orm";
import type { Tx } from "../../db/index.ts";
import { librarianReceipts, librarianRuns } from "../../db/schema.ts";
import type { Deps } from "../../deps.ts";
import {
  claimRun,
  finishRun,
  heartbeatRun,
  loadSafeConfig,
  type RunFence,
  reserveAttempt,
  settleAttempt,
  withRunFence,
} from "../index.ts";
import { executeRun, type InboxContext, type RunnerServices, type Snapshot } from "./engine.ts";
import type { LibrarianProvider } from "./provider.ts";
import { prepareAndPersist, withToolReceipt } from "./receipts.ts";
import { mutation, type ToolName } from "./tools.ts";

export type { RunnerServices, Snapshot } from "./engine.ts";
export { executeRun } from "./engine.ts";
export type { LibrarianProvider } from "./provider.ts";
/** Missing root-owned transactional adapters. Do not register until implemented. */
export interface RunnerIntegration {
  /** Atomically bind eligible inbox or unique wiki/day work during claim. Foundation claim alone lacks this. */
  claim(deps: Deps): Promise<RunFence | null>;
  context?(deps: Deps, fence: RunFence): Promise<InboxContext | null>;
  /** Install cross-replica persistent cancellation subscription before provider construction. */
  cancellation(deps: Deps, fence: RunFence): Promise<{ signal: AbortSignal; close(): Promise<void> }>;
  /** Trusted adapter obtains key per operation through withProviderKey. No ambient credentials. */
  provider(deps: Deps, fence: RunFence): Promise<LibrarianProvider>;
  /** Execute under supplied transaction; content lock + current can + explicit wiki ceiling + agentPolicy,
   * existing editing operations, visible citations and receipt all commit together. Checkpoint staging may
   * perform verified blob I/O before the final durable fence check; no independent DB commits. */
  /** Check page/source/citation visibility before receipt replay, in this same transaction. */
  authorizeTool(tx: Tx, fence: RunFence, wikiId: string, name: ToolName, input: unknown): Promise<void>;
  tool(
    tx: Tx,
    fence: RunFence,
    wikiId: string,
    name: ToolName,
    input: unknown,
    receipt: { id: string; inputHash: string },
    maxBytes: number,
  ): Promise<unknown>;
  disableUnauthorized(deps: Deps, fence: RunFence): Promise<void>;
  /** Atomic terminal activity/inbox/results update with foundation ledger finalization. */
  finish(deps: Deps, fence: RunFence, state: Parameters<RunnerServices["finish"]>[0]): Promise<void>;
}
/** Supplies the named job; root wires its tick and OPS route outside the daily jobs transaction. */
export function registerLibrarianJob(
  deps: Deps,
  integration: RunnerIntegration,
): { librarian: () => Promise<unknown> } {
  return {
    librarian: async () => {
      if (!deps.env.librarianAllowed) return null;
      const fence = await integration.claim(deps);
      if (!fence) return null;
      const config = await loadSafeConfig(deps, fence.orgId);
      if (!config.enabled) return null;
      const run = await withRunFence(deps, fence, async (tx) => {
        const [row] = await tx.select().from(librarianRuns).where(eq(librarianRuns.id, fence.runId));
        if (!row) throw new Error("unavailable");
        return row;
      });
      const cancellation = await integration.cancellation(deps, fence);
      const controller = new AbortController();
      const abort = () => controller.abort();
      cancellation.signal.addEventListener("abort", abort, { once: true });
      if (cancellation.signal.aborted) abort();
      const deadline = setTimeout(abort, Math.max(0, run.deadline.getTime() - deps.clock.now().getTime()));
      let beating = false;
      const heartbeat = setInterval(async () => {
        if (beating) return;
        beating = true;
        try {
          await heartbeatRun(deps, fence);
        } catch {
          abort();
        } finally {
          beating = false;
        }
      }, 30000);
      try {
        const provider = await integration.provider(deps, fence);
        const snapshot: Snapshot = {
          model: run.model,
          rates: run.rateCard,
          deadline: run.deadline.getTime(),
        };
        return await executeRun(fence, snapshot, provider, {
          context: () => integration.context?.(deps, fence) ?? Promise.resolve(null),
          now: () => deps.clock.now().getTime(),
          signal: controller.signal,
          check: () => withRunFence(deps, fence, async () => {}),
          heartbeat: () => heartbeatRun(deps, fence),
          reserve: (attemptId, ceilingMicrousd) =>
            reserveAttempt(deps, fence, { attemptId, ceilingMicrousd }),
          settle: (attemptId, outcome, actualMicrousd, requestId) =>
            settleAttempt(deps, {
              orgId: fence.orgId,
              runId: fence.runId,
              attemptId,
              outcome,
              actualMicrousd,
              requestId,
            }),
          finish: (state) => integration.finish(deps, fence, state),
          disableUnauthorized: () => integration.disableUnauthorized(deps, fence),
          wait: (ms) =>
            new Promise<void>((resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              const cancel = () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              };
              const timer = setTimeout(() => {
                controller.signal.removeEventListener("abort", cancel);
                resolve();
              }, ms);
              controller.signal.addEventListener("abort", cancel, { once: true });
            }),
          tool: (name, input, receipt, maxBytes) =>
            prepareAndPersist(
              deps,
              fence,
              receipt.id,
              async (tx) => {
                await integration.authorizeTool(tx, fence, run.wikiId, name, input);
                return mutation(name)
                  ? withToolReceipt(tx, fence, receipt, maxBytes, async () => {
                      const value = await integration.tool(
                        tx,
                        fence,
                        run.wikiId,
                        name,
                        input,
                        receipt,
                        maxBytes,
                      );
                      if (name === "page_delegate_start") {
                        const id = (value as { id?: unknown })?.id;
                        if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
                          throw new Error("invalid_delegate");
                        await tx.insert(librarianReceipts).values({
                          orgId: fence.orgId,
                          runId: fence.runId,
                          toolKey: crypto.randomUUID(),
                          inputHash: receipt.inputHash,
                          result: { kind: "delegate_ownership", editRunId: id },
                        });
                      }
                      return value;
                    })
                  : integration.tool(tx, fence, run.wikiId, name, input, receipt, maxBytes);
              },
              (tx) => integration.authorizeTool(tx, fence, run.wikiId, name, input),
            ),
          event: (code) => deps.log.info("librarian runner", { code, runId: fence.runId }),
        });
      } finally {
        clearTimeout(deadline);
        clearInterval(heartbeat);
        cancellation.signal.removeEventListener("abort", abort);
        await cancellation.close();
      }
    },
  };
}
// Foundation functions deliberately not composed as defaults: they lack inbox and terminal activity binding.
export const foundationPrimitives = { claimRun, finishRun };
