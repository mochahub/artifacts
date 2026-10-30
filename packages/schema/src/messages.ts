import { z } from "zod";

/** Frame ↔ viewer bridge messages (08, "The bridge"). */
const Scope = z.enum(["shared", "me"]);
const Json: z.ZodType<unknown> = z.json();

/** 02: 1–200 characters of A-Za-z0-9._/-, no leading /, and no "." or ".." segment. */
export const isDataKey = (key: string) =>
  /^[A-Za-z0-9._/-]{1,200}$/.test(key) &&
  !key.startsWith("/") &&
  !key.split("/").some((part) => part === "." || part === "..");
// The viewer builds URLs from these with its own session, so a frame's key can't be allowed to climb out.
const Key = z.string().refine(isDataKey);

export const BridgeOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get"), scope: Scope, key: Key }),
  z.object({
    kind: z.literal("list"),
    scope: Scope,
    prefix: z.string().optional(),
    cursor: z.string().optional(),
  }),
  z.object({
    kind: z.literal("put"),
    scope: Scope,
    key: Key,
    value: Json,
    ifMatch: z.string().optional(), // "*" means only if new
  }),
  z.object({ kind: z.literal("delete"), scope: Scope, key: Key, ifMatch: z.string().optional() }),
  z.object({ kind: z.literal("file.put"), scope: Scope, name: Key, blob: z.instanceof(Blob) }),
  z.object({ kind: z.literal("file.url"), scope: Scope, name: Key }),
  z.object({ kind: z.literal("file.list"), scope: Scope }),
  z.object({ kind: z.literal("file.delete"), scope: Scope, name: Key }),
  z.object({ kind: z.literal("whoami") }),
]);
export type BridgeOp = z.infer<typeof BridgeOp>;

export const BridgeRequest = z.object({ artifacts: z.literal(1), id: z.string(), op: BridgeOp });
export type BridgeRequest = z.infer<typeof BridgeRequest>;

export const BridgeErrorCode = z.enum([
  "precondition_failed",
  "read_only",
  "too_large",
  "forbidden",
  "not_found",
  "rate_limited",
  "invalid",
]);

export const BridgeResponse = z.discriminatedUnion("ok", [
  z.object({ artifacts: z.literal(1), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    artifacts: z.literal(1),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: BridgeErrorCode, message: z.string() }),
  }),
]);
export type BridgeResponse = z.infer<typeof BridgeResponse>;
