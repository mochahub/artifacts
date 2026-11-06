import { type AuthenticatorTransport, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { OrgRow } from "../db/index.ts";
import { passkeys, people, webauthnChallenges } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import type { Caller } from "./caller.ts";
import { markReauthed } from "./sessions.ts";

const CHALLENGE_MS = 5 * 60_000;

export const bytes = (base64url: string) => new Uint8Array(Buffer.from(base64url, "base64url"));

export type Passkeys = ReturnType<typeof createPasskeys>;

/** WebAuthn challenges and assertions, for signing in and for confirming it's you again (04). */
export function createPasskeys(deps: Deps) {
  const { db, clock } = deps;

  const expected = async () => {
    const origins = await deps.origins();
    return { origins, rpIds: [...new Set(origins.map((origin) => new URL(origin).hostname))] };
  };

  async function saveChallenge(org: OrgRow, challenge: string, kind: string, personId: string | null) {
    const id = Bun.randomUUIDv7();
    const now = clock.now();
    await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));
    await db.insert(webauthnChallenges).values({
      id,
      orgId: org.id,
      challenge,
      kind,
      personId,
      expiresAt: new Date(now.getTime() + CHALLENGE_MS),
    });
    return id;
  }

  /** Single use: whoever deletes the row owns it (04). */
  async function takeChallenge(org: OrgRow, id: string, kind: string, personId: string | null) {
    const [row] = await db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.id, id),
          eq(webauthnChallenges.orgId, org.id),
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
  async function assertion(org: OrgRow, challengeId: string, response: unknown) {
    const challenge = await takeChallenge(org, challengeId, "authenticate", null);
    const credentialId = (response as { id?: unknown })?.id;
    if (typeof credentialId !== "string") throw new ApiError("invalid", "That isn't a passkey response.");
    const [row] = await db
      .select({ passkey: passkeys, person: people })
      .from(passkeys)
      .innerJoin(people, eq(people.id, passkeys.personId))
      .where(
        and(
          eq(passkeys.orgId, org.id),
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

  /** For POST /api/auth/reauth: only this person's own passkey confirms them. */
  async function reauth(
    org: OrgRow,
    caller: Extract<Caller, { kind: "person" }>,
    challengeId: string,
    response: unknown,
  ) {
    const person = await assertion(org, challengeId, response);
    if (person.id !== caller.person.id)
      throw new ApiError("unauthenticated", "That's someone else's passkey.");
    await markReauthed(deps, caller.sessionId);
  }

  return { expected, saveChallenge, takeChallenge, assertion, reauth };
}
