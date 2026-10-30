import { AddPasskeyVerify, PasskeyOptions, PasskeyVerify, RenamePasskey } from "@artifacts/schema";
import {
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { personView, startSession } from "../auth/sessions.ts";
import { passkeys, passwords, people, sessions, webauthnChallenges } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

const CHALLENGE_MS = 5 * 60_000;

const bytes = (base64url: string) => new Uint8Array(Buffer.from(base64url, "base64url"));
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

export function passkeyRoutes(routes: Routes, deps: Deps) {
  const { db, clock } = deps;

  const hostname = (c: ApiContext) => (c.req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "";

  /** The home domain, or this domain for a browser without Related Origin Requests (04). */
  const rpFor = (c: ApiContext, local?: boolean) => (local ? hostname(c) : c.get("org").homeDomain);

  const expected = async () => {
    const origins = await deps.origins();
    return { origins, rpIds: [...new Set(origins.map((origin) => new URL(origin).hostname))] };
  };

  async function saveChallenge(c: ApiContext, challenge: string, kind: string, personId: string | null) {
    const id = Bun.randomUUIDv7();
    const now = clock.now();
    await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));
    await db.insert(webauthnChallenges).values({
      id,
      orgId: c.get("org").id,
      challenge,
      kind,
      personId,
      expiresAt: new Date(now.getTime() + CHALLENGE_MS),
    });
    return id;
  }

  /** Single use: whoever deletes the row owns it (04). */
  async function takeChallenge(c: ApiContext, id: string, kind: string, personId: string | null) {
    const [row] = await db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.id, id),
          eq(webauthnChallenges.orgId, c.get("org").id),
          eq(webauthnChallenges.kind, kind),
          personId ? eq(webauthnChallenges.personId, personId) : isNull(webauthnChallenges.personId),
          gt(webauthnChallenges.expiresAt, clock.now()),
        ),
      )
      .returning();
    if (!row) throw new ApiError("unauthenticated", "That sign-in attempt expired. Try again.");
    return row.challenge;
  }

  /** Verifies an assertion and returns the person, for sign-in and for re-authentication. */
  async function assertion(c: ApiContext, challengeId: string, response: unknown) {
    const challenge = await takeChallenge(c, challengeId, "authenticate", null);
    const credentialId = (response as { id?: unknown })?.id;
    if (typeof credentialId !== "string") throw new ApiError("invalid", "That isn't a passkey response.");
    const [row] = await db
      .select({ passkey: passkeys, person: people })
      .from(passkeys)
      .innerJoin(people, eq(people.id, passkeys.personId))
      .where(
        and(
          eq(passkeys.orgId, c.get("org").id),
          eq(passkeys.credentialId, bytes(credentialId)),
          isNull(people.removedAt),
        ),
      )
      .limit(1);
    if (!row) throw new ApiError("unauthenticated", "That passkey isn't registered here.");
    const { origins, rpIds } = await expected();
    const result = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpIds,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: row.passkey.publicKey as Uint8Array<ArrayBuffer>,
        counter: row.passkey.counter,
        transports: row.passkey.transports as AuthenticatorTransport[],
      },
    }).catch(() => ({ verified: false as const, authenticationInfo: null }));
    if (!result.verified || !result.authenticationInfo) {
      throw new ApiError("unauthenticated", "That passkey didn't verify.");
    }
    await db
      .update(passkeys)
      .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: clock.now() })
      .where(eq(passkeys.id, row.passkey.id));
    return row.person;
  }

  routes.post("/api/auth/passkey/options", { public: true }, async (c) => {
    const { local } = await parseBody(c, PasskeyOptions);
    const options = await generateAuthenticationOptions({
      rpID: rpFor(c as ApiContext, local),
      userVerification: "required",
      allowCredentials: [],
    });
    const challengeId = await saveChallenge(c as ApiContext, options.challenge, "authenticate", null);
    return c.json({ ...options, challengeId });
  });

  routes.post("/api/auth/passkey/verify", { public: true }, async (c) => {
    const { challengeId, response } = await parseBody(c, PasskeyVerify);
    const person = await assertion(c as ApiContext, challengeId, response);
    await startSession(c, deps, person.orgId, person.id);
    return c.json({ person: personView(person) });
  });

  const session = (caller: Caller) => {
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    return caller;
  };

  routes.get("/api/me/passkeys", { action: "account.manage" }, async (c) => {
    const { person } = session(c.get("caller"));
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
    const { person } = session(c.get("caller"));
    const { local } = await parseBody(c, PasskeyOptions);
    const existing = await db.select().from(passkeys).where(eq(passkeys.personId, person.id));
    const options = await generateRegistrationOptions({
      rpName: c.get("org").name,
      rpID: rpFor(c as ApiContext, local),
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
    const challengeId = await saveChallenge(c as ApiContext, options.challenge, "register", person.id);
    return c.json({ ...options, challengeId });
  });

  routes.post("/api/me/passkeys/verify", { action: "account.manage", recentAuth: true }, async (c) => {
    const { person } = session(c.get("caller"));
    const body = await parseBody(c, AddPasskeyVerify);
    const challenge = await takeChallenge(c as ApiContext, body.challengeId, "register", person.id);
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
        orgId: c.get("org").id,
        personId: person.id,
        credentialId: bytes(credential.id),
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        rpId: result.registrationInfo.rpID ?? c.get("org").homeDomain,
        name: body.name ?? "Passkey",
        createdAt: clock.now(),
      })
      .returning();
    return c.json({ passkey: { id: row?.id, name: row?.name } });
  });

  async function ownPasskey(c: ApiContext) {
    const { person } = session(c.get("caller"));
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
    const row = await ownPasskey(c as ApiContext);
    const { name } = await parseBody(c, RenamePasskey);
    await db.update(passkeys).set({ name }).where(eq(passkeys.id, row.id));
    return c.json({ ok: true });
  });

  routes.delete("/api/me/passkeys/:id", { action: "account.manage", recentAuth: true }, async (c) => {
    const row = await ownPasskey(c as ApiContext);
    const [others, password] = await Promise.all([
      db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.personId, row.personId)),
      db
        .select({ id: passwords.personId })
        .from(passwords)
        .where(eq(passwords.personId, row.personId))
        .limit(1),
    ]);
    if (others.length <= 1 && password.length === 0) {
      throw new ApiError("conflict", "This is your only way to sign in. Add another first.");
    }
    await db.delete(passkeys).where(eq(passkeys.id, row.id));
    return c.json({ ok: true });
  });

  return {
    /** For POST /api/auth/reauth. */
    async reauth(c: ApiContext, challengeId: string, response: unknown) {
      const caller = session(c.get("caller"));
      const person = await assertion(c, challengeId, response);
      if (person.id !== caller.person.id)
        throw new ApiError("unauthenticated", "That's someone else's passkey.");
      await db.update(sessions).set({ authAt: clock.now() }).where(eq(sessions.id, caller.sessionId));
    },
  };
}
