import { z } from "zod";

/** Frame ↔ viewer bridge messages (08, "The bridge"). */
const Scope = z.enum(["shared", "me"]);
const Json: z.ZodType<unknown> = z.json();

export const BridgeOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get"), scope: Scope, key: z.string() }),
  z.object({
    kind: z.literal("list"),
    scope: Scope,
    prefix: z.string().optional(),
    cursor: z.string().optional(),
  }),
  z.object({
    kind: z.literal("put"),
    scope: Scope,
    key: z.string(),
    value: Json,
    ifMatch: z.string().optional(), // "*" means only if new
  }),
  z.object({ kind: z.literal("delete"), scope: Scope, key: z.string(), ifMatch: z.string().optional() }),
  z.object({ kind: z.literal("file.put"), scope: Scope, name: z.string(), blob: z.instanceof(Blob) }),
  z.object({ kind: z.literal("file.url"), scope: Scope, name: z.string() }),
  z.object({ kind: z.literal("file.list"), scope: Scope }),
  z.object({ kind: z.literal("file.delete"), scope: Scope, name: z.string() }),
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
