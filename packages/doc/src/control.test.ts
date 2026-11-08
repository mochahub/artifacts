import { expect, test } from "bun:test";
import { CHECKPOINT_KINDS, EDIT_MODES, RUN_STATUSES, SUGGESTION_STATUSES } from "@artifacts/schema/constants";
import { SyncControl } from "@artifacts/schema/editing";
import { parseControl } from "./control.ts";

test("browser control validation agrees with the contract across valid envelopes and malformed fields", () => {
  const messages = [
    { t: "hello", author: "a", epoch: 1, seq: 0, version: 2, canAccept: true },
    { t: "mode", mode: "write" },
    { t: "checkpoint", version: 2, kind: "saved" },
    { t: "suggestion", id: "12345678-1234-4234-8234-123456789abc", status: "open" },
    { t: "run", id: "12345678-1234-4234-8234-123456789abc", status: "active" },
    { t: "reset", epoch: 2, version: 3 },
    { t: "error", code: "rate_limited", message: "Wait" },
  ];
  const values = [undefined, null, false, {}, [], "", -1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const message of messages) {
    const extra = { ...message, ignored: true };
    expect(parseControl(extra)).toEqual({ success: true, data: SyncControl.parse(extra) });
    expect(parseControl(message).success).toBe(true);
    for (const key of Object.keys(message)) {
      const missing = { ...message } as Record<string, unknown>;
      delete missing[key];
      expect(parseControl(missing).success).toBe(SyncControl.safeParse(missing).success);
      for (const value of values) {
        const candidate = { ...message, [key]: value };
        expect(parseControl(candidate).success).toBe(SyncControl.safeParse(candidate).success);
      }
    }
  }
});

test("UUID boundary and every control enum retain canonical validation", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const variants = [
    ...EDIT_MODES.map((mode) => ({ t: "mode", mode })),
    ...CHECKPOINT_KINDS.map((kind) => ({ t: "checkpoint", kind, version: 1 })),
    ...SUGGESTION_STATUSES.map((status) => ({ t: "suggestion", status, id })),
    ...RUN_STATUSES.map((status) => ({ t: "run", status, id })),
  ];
  for (const value of variants)
    expect(parseControl(value)).toEqual({ success: true, data: SyncControl.parse(value) });
  for (const id of [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "12345678-1234-0234-8234-123456789abc",
    "12345678-1234-4234-7234-123456789abc",
    "not-an-id",
  ]) {
    const value = { t: "run", id, status: "active" };
    expect(parseControl(value).success).toBe(SyncControl.safeParse(value).success);
  }
});
