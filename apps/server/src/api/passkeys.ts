import { AddPasskeyVerify, PasskeyOptions, PasskeyVerify, RenamePasskey } from "@artifacts/schema";
import {
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { bytes, type Passkeys } from "../auth/passkeys.ts";
import { personView, startSession } from "../auth/sessions.ts";
import { identities, passkeys, passwords } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import type { RouteRequest, Routes } from "../http/routes.ts";

const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

export function passkeyRoutes(routes: Routes, deps: Deps, keys: Passkeys) {
  const { db, clock } = deps;
  const { expected, saveChallenge, takeChallenge, assertion } = keys;

  /** The home domain, or this domain for a browser without Related Origin Requests (04). */
  const rpFor = (c: RouteRequest, local?: boolean) =>
    local ? ((c.req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "") : c.var.org.homeDomain;

  routes.post("/api/auth/passkey/options", { public: true }, async (c) => {
    // Every call writes a row for 5 minutes, and anyone can make one.
    deps.limits.hit(`passkey-options:${deps.clientIp(c)}`, 60, 15 * 60_000);
    const { local } = await parseBody(c, PasskeyOptions);
    const options = await generateAuthenticationOptions({
      rpID: rpFor(c, local),
      userVerification: "required",
      allowCredentials: [],
    });
    const challengeId = await saveChallenge(c.var.org, options.challenge, "authenticate", null);
    return c.json({ ...options, challengeId });
  });

  routes.post("/api/auth/passkey/verify", { public: true }, async (c) => {
    const { challengeId, response } = await parseBody(c, PasskeyVerify);
    const person = await assertion(c.var.org, challengeId, response);
    await startSession(c, deps, person.orgId, person.id);
    return c.json({ person: personView(person) });
  });

  routes.get("/api/me/passkeys", { action: "account.manage" }, async (c) => {
    const { person } = c.var.caller;
    const [rows, password] = await Promise.all([
      db.select().from(passkeys).where(eq(passkeys.personId, person.id)),
      db
        .select({ at: passwords.updatedAt })
        .from(passwords)
        .where(eq(passwords.personId, person.id))
        .limit(1),
    ]);
    return c.json({
      passkeys: rows.map((row) => ({
        id: row.id,
        name: row.name,
        rpId: row.rpId,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })),
      passwordSetAt: password[0]?.at.toISOString() ?? null,
    });
  });

  routes.post("/api/me/passkeys/options", { action: "account.manage", recentAuth: true }, async (c) => {
    const { person } = c.var.caller;
    const { local } = await parseBody(c, PasskeyOptions);
    const existing = await db.select().from(passkeys).where(eq(passkeys.personId, person.id));
    const options = await generateRegistrationOptions({
      rpName: c.var.org.name,
      rpID: rpFor(c, local),
      userName: person.email,
      userDisplayName: person.name,
      userID: new TextEncoder().encode(person.id),
      attestationType: "none",
      excludeCredentials: existing.map((row) => ({
        id: b64(row.credentialId),
        transports: row.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const challengeId = await saveChallenge(c.var.org, options.challenge, "register", person.id);
    return c.json({ ...options, challengeId });
  });

  routes.post("/api/me/passkeys/verify", { action: "account.manage", recentAuth: true }, async (c) => {
    const { person } = c.var.caller;
    const body = await parseBody(c, AddPasskeyVerify);
    const challenge = await takeChallenge(c.var.org, body.challengeId, "register", person.id);
    const { origins, rpIds } = await expected();
    const result = await verifyRegistrationResponse({
      response: body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpIds,
      requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified || !result.registrationInfo)
      throw new ApiError("invalid", "That passkey didn't verify.");
    const { credential } = result.registrationInfo;
    const [row] = await db
      .insert(passkeys)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.var.org.id,
        personId: person.id,
        credentialId: bytes(credential.id),
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        rpId: result.registrationInfo.rpID ?? c.var.org.homeDomain,
        name: body.name ?? "Passkey",
        createdAt: clock.now(),
      })
      .returning();
    return c.json({ passkey: { id: row?.id, name: row?.name } });
  });

  async function ownPasskey(c: RouteRequest<Extract<Caller, { kind: "person" }>>) {
    const { person } = c.var.caller;
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(passkeys)
          .where(and(eq(passkeys.id, id), eq(passkeys.personId, person.id)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    return row;
  }

  routes.patch("/api/me/passkeys/:id", { action: "account.manage" }, async (c) => {
    const row = await ownPasskey(c);
    const { name } = await parseBody(c, RenamePasskey);
    await db.update(passkeys).set({ name }).where(eq(passkeys.id, row.id));
    return c.json({ ok: true });
  });

  routes.delete("/api/me/passkeys/:id", { action: "account.manage", recentAuth: true }, async (c) => {
    const row = await ownPasskey(c);
    const [others, password, linked] = await Promise.all([
      db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.personId, row.personId)),
      db
        .select({ id: passwords.personId })
        .from(passwords)
        .where(eq(passwords.personId, row.personId))
        .limit(1),
      db.select({ id: identities.id }).from(identities).where(eq(identities.personId, row.personId)),
    ]);
    const google = c.var.org.googleEnabled && linked.length > 0;
    if (others.length <= 1 && password.length === 0 && !google) {
      throw new ApiError("conflict", "This is your only way to sign in. Add another first.");
    }
    await db.delete(passkeys).where(eq(passkeys.id, row.id));
    return c.json({ ok: true });
  });
}
