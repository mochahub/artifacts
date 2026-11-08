import { CHECKPOINT_KINDS, EDIT_MODES, RUN_STATUSES, SUGGESTION_STATUSES } from "@artifacts/schema/constants";
import type { SyncControl } from "@artifacts/schema/editing";

export { SYNC_CLOSE } from "@artifacts/schema/constants";

/** Browser boundary for the small control envelope. Keep parity with the contract schema. */
export function parseControl(value: unknown): { success: true; data: SyncControl } | { success: false } {
  if (!value || typeof value !== "object") return { success: false };
  const v = value as Record<string, unknown>;
  const integer = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x);
  const member = (xs: readonly string[], x: unknown) => typeof x === "string" && xs.includes(x);
  const id =
    typeof v.id === "string" &&
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      v.id,
    );
  let valid = false;
  switch (v.t) {
    case "hello":
      valid =
        typeof v.author === "string" &&
        integer(v.epoch) &&
        integer(v.seq) &&
        integer(v.version) &&
        typeof v.canAccept === "boolean";
      break;
    case "mode":
      valid = member(EDIT_MODES, v.mode);
      break;
    case "checkpoint":
      valid = integer(v.version) && member(CHECKPOINT_KINDS, v.kind);
      break;
    case "suggestion":
      valid = id && member(SUGGESTION_STATUSES, v.status);
      break;
    case "run":
      valid = id && member(RUN_STATUSES, v.status);
      break;
    case "reset":
      valid = integer(v.epoch) && integer(v.version);
      break;
    case "error":
      valid =
        member(["checkpoint_failed", "invalid_update", "too_large", "rate_limited"], v.code) &&
        typeof v.message === "string";
      break;
  }
  if (!valid) return { success: false };
  // Like z.object, return only the declared fields.
  const fields: Record<SyncControl["t"], string[]> = {
    hello: ["author", "epoch", "seq", "version", "canAccept"],
    mode: ["mode"],
    checkpoint: ["version", "kind"],
    suggestion: ["id", "status"],
    run: ["id", "status"],
    reset: ["epoch", "version"],
    error: ["code", "message"],
  };
  return {
    success: true,
    data: Object.fromEntries(
      ["t", ...(fields[v.t as SyncControl["t"]] ?? [])].map((key) => [key, v[key]]),
    ) as SyncControl,
  };
}
