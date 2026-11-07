import type { PushKey } from "@artifacts/schema";
import { PushSubscribe } from "@artifacts/schema";
import { and, eq, ne } from "drizzle-orm";
import { pushSubscriptions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import type { Routes } from "../http/routes.ts";
import { vapidKeys } from "./notify.ts";

const MAX_SUBSCRIPTIONS_PER_PERSON = 10;

export function pushRoutes(routes: Routes, deps: Deps) {
  routes.get("/api/push/key", { action: "account.manage" }, async (c) => {
    return c.json({ key: (await vapidKeys(deps)).publicKey } satisfies PushKey);
  });

  routes.post("/api/push/subscribe", { action: "account.manage" }, async (c) => {
    const { person: me, sessionId: session } = c.var.caller;
    const body = await parseBody(c, PushSubscribe);
    if (!deps.pushAllow(body.endpoint)) throw new ApiError("invalid", "That isn't a push service.");
    // A browser's keys are an uncompressed P-256 point and 16 bytes of secret; anything else can't be sent to.
    const point = Buffer.from(body.keys.p256dh, "base64url");
    if (point.length !== 65 || point[0] !== 4 || Buffer.from(body.keys.auth, "base64url").length !== 16) {
      throw new ApiError("invalid", "Those aren't a browser's push keys.");
    }
    const existing = await deps.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.personId, me.id), ne(pushSubscriptions.endpoint, body.endpoint)));
    if (existing.length >= MAX_SUBSCRIPTIONS_PER_PERSON) {
      throw new ApiError("conflict", "Too many devices have notifications on. Turn some off first.");
    }
    await deps.db
      .insert(pushSubscriptions)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.get("org").id,
        personId: me.id,
        sessionId: session,
        endpoint: body.endpoint,
        keys: body.keys,
        createdAt: deps.clock.now(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { personId: me.id, sessionId: session, keys: body.keys },
      });
    return c.json({ ok: true });
  });

  routes.delete("/api/push/subscribe", { action: "account.manage" }, async (c) => {
    const me = c.var.caller.person;
    const { endpoint } = await parseBody(c, PushSubscribe.pick({ endpoint: true }));
    await deps.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.personId, me.id), eq(pushSubscriptions.endpoint, endpoint)));
    return c.json({ ok: true });
  });
}
