import { DevicePoll, DeviceStart } from "@artifacts/schema";
import { and, eq, gt } from "drizzle-orm";
import { newUserCode, randomSecret, sha256 } from "../auth/secrets.ts";
import { createCliToken, personView } from "../auth/sessions.ts";
import { deviceCodes, people } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

const EXPIRES_IN = 600;
const INTERVAL = 5;
const HOUR = 3600_000;

const normalize = (code: string) => {
  const letters = code.toUpperCase().replace(/[^A-Z]/g, "");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};

export function deviceRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock, limits } = deps;

  routes.post("/api/device/start", { public: true }, async (c) => {
    limits.hit(`device-start:${deps.clientIp(c)}`, 10, HOUR);
    const body = await parseBody(c, DeviceStart);
    const deviceCode = randomSecret();
    const userCode = newUserCode();
    const now = clock.now();
    await db.insert(deviceCodes).values({
      id: Bun.randomUUIDv7(),
      orgId: c.get("org").id,
      deviceCodeHash: sha256(deviceCode),
      userCode,
      clientName: body.clientName,
      agent: body.agent ?? null,
      ip: deps.clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + EXPIRES_IN * 1000),
    });
    return c.json({
      deviceCode,
      userCode,
      verificationUrl: `${env.publicUrl}/device`,
      interval: INTERVAL,
      expiresIn: EXPIRES_IN,
    });
  });

  routes.post("/api/device/poll", { public: true }, async (c) => {
    const { deviceCode } = await parseBody(c, DevicePoll);
    const hash = sha256(deviceCode);
    const [row] = await db
      .select()
      .from(deviceCodes)
      .where(and(eq(deviceCodes.orgId, c.get("org").id), eq(deviceCodes.deviceCodeHash, hash)))
      .limit(1);
    if (!row) throw new ApiError("not_found", "Not found.");
    limits.hit(`device-poll:${hash}`, 1, INTERVAL * 1000);
    if (row.status === "denied") return c.json({ status: "denied" });
    if (row.status === "used" || row.expiresAt <= clock.now()) {
      throw new ApiError("gone", "This sign-in expired. Run artifacts login again.");
    }
    if (row.status === "pending") return c.json({ status: "pending" });

    // Only one poll can move it from approved to used, so the token is handed out once.
    const claimed = await db
      .update(deviceCodes)
      .set({ status: "used" })
      .where(and(eq(deviceCodes.id, row.id), eq(deviceCodes.status, "approved")))
      .returning({ id: deviceCodes.id });
    if (claimed.length === 0) throw new ApiError("gone", "This sign-in was already used.");
    const [person] = await db
      .select()
      .from(people)
      .where(eq(people.id, row.personId as string))
      .limit(1);
    if (!person || person.removedAt) throw new ApiError("gone", "This sign-in no longer works.");
    const token = await createCliToken(db, {
      orgId: row.orgId,
      personId: person.id,
      name: `artifacts CLI on ${row.clientName}`,
      now: clock.now(),
    });
    return c.json({ status: "approved", token, person: personView(person) });
  });

  async function pending(c: ApiContext) {
    const [row] = await db
      .select()
      .from(deviceCodes)
      .where(
        and(
          eq(deviceCodes.orgId, c.get("org").id),
          eq(deviceCodes.userCode, normalize(c.req.param("userCode") as string)),
          eq(deviceCodes.status, "pending"),
          gt(deviceCodes.expiresAt, clock.now()),
        ),
      )
      .limit(1);
    if (!row)
      throw new ApiError(
        "not_found",
        "That code isn't waiting for approval. Check the code in your terminal.",
      );
    return row;
  }

  routes.get("/api/device/:userCode", { action: "account.manage" }, async (c) => {
    const row = await pending(c as ApiContext);
    return c.json({
      clientName: row.clientName,
      agent: row.agent,
      createdAt: row.createdAt.toISOString(),
      ip: row.ip,
      userAgent: row.userAgent,
    });
  });

  routes.post("/api/device/:userCode/approve", { action: "account.manage", recentAuth: true }, async (c) => {
    const row = await pending(c as ApiContext);
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    await db
      .update(deviceCodes)
      .set({ status: "approved", personId: caller.person.id })
      .where(eq(deviceCodes.id, row.id));
    return c.json({ ok: true });
  });

  routes.post("/api/device/:userCode/deny", { action: "account.manage" }, async (c) => {
    const row = await pending(c as ApiContext);
    await db.update(deviceCodes).set({ status: "denied" }).where(eq(deviceCodes.id, row.id));
    return c.json({ ok: true });
  });
}
