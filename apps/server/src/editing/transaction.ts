import { AsyncLocalStorage } from "node:async_hooks";
import type { Tx } from "../db/index.ts";

/** Outer transaction owners flush this queue only after commit; rollback simply drops it. */
const callbacks = new WeakMap<Tx, (() => void)[]>();
export function registerAfterCommit(tx: Tx, queue: (() => void)[]) {
  callbacks.set(tx, queue);
}
export function afterCommit(tx: Tx, fn: () => void) {
  const queue = callbacks.get(tx);
  if (!queue) throw new Error("Outer transaction must register its after-commit queue.");
  queue.push(fn);
}
export type Preparation = {
  snapshots: Map<string, string>;
  seen: Set<string>;
  ids: string[];
  index: number;
  bucket: unknown;
  now: Date;
  limits: Set<string>;
  computed: Map<string, unknown>;
};
export const preparation = new AsyncLocalStorage<Preparation>();
export function captureSnapshot(key: string, value: unknown) {
  const state = preparation.getStore();
  if (!state || state.seen.has(key)) return;
  state.seen.add(key);
  const encoded = JSON.stringify(value);
  const prior = state.snapshots.get(key);
  if (prior !== undefined && prior !== encoded) throw new Error("Stale content preparation.");
  state.snapshots.set(key, encoded);
}
export function preparedId(mint: () => string) {
  const state = preparation.getStore();
  if (!state) return mint();
  const index = state.index++;
  if (state.ids[index] === undefined) state.ids[index] = mint();
  return state.ids[index];
}

/** Unwinds the current transaction before running bounded storage or pure preparation work. */
export class PreparationRequired extends Error {
  constructor(readonly perform: () => Promise<void>) {
    super("preparation_required");
  }
}
export async function outsideTransaction<T>(key: string, compute: () => T | Promise<T>): Promise<T> {
  const state = preparation.getStore();
  if (!state) return compute();
  if (state.computed.has(key)) return state.computed.get(key) as T;
  throw new PreparationRequired(async () => {
    state.computed.set(key, await compute());
  });
}
