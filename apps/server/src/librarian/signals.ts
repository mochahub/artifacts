import type { Deps } from "../deps.ts";
import { type RunFence, withRunFence } from "./leases.ts";

/** Poll durable fences on every replica. Abort is advisory; mutations still need withRunFence. */
export async function subscribeRunCancellation(
  deps: Deps,
  fence: RunFence,
  intervalMs = 1000,
): Promise<{ signal: AbortSignal; close(): Promise<void> }> {
  await withRunFence(deps, fence, async () => {});
  const controller = new AbortController();
  let stopped = false;
  let checking: Promise<void> | undefined;
  const timer = setInterval(
    () => {
      if (stopped || checking) return;
      checking = withRunFence(deps, fence, async () => {})
        .catch(() => {
          controller.abort(new Error("Librarian execution stopped"));
        })
        .finally(() => {
          checking = undefined;
        });
    },
    Math.max(50, intervalMs),
  );
  return {
    signal: controller.signal,
    async close() {
      stopped = true;
      clearInterval(timer);
      await checking;
    },
  };
}
export async function withRunSignal<T>(
  deps: Deps,
  fence: RunFence,
  use: (signal: AbortSignal) => Promise<T>,
  intervalMs = 1000,
): Promise<T> {
  const subscription = await subscribeRunCancellation(deps, fence, intervalMs);
  try {
    return await use(subscription.signal);
  } finally {
    await subscription.close();
  }
}
