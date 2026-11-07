import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db, Tx } from "../db/index.ts";
import { oauthGrants, sessions, tokens } from "../db/schema.ts";

/** One connector, and every token issued from it. Replaying a used code or refresh token does this too. */
export async function revokeGrant(db: Pick<Db | Tx, "update">, grantId: string, now: Date) {
  await db.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, grantId));
  await db
    .update(tokens)
    .set({ revokedAt: now })
    .where(and(eq(tokens.grantId, grantId), isNull(tokens.revokedAt)));
}

/** Every connector a person signed in. Their refresh tokens end with the grant (see the token route). */
export async function revokeGrants(tx: Tx, personId: string, now: Date) {
  await tx
    .update(oauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(oauthGrants.personId, personId), isNull(oauthGrants.revokedAt)));
  await tx
    .update(tokens)
    .set({ revokedAt: now })
    .where(and(eq(tokens.personId, personId), eq(tokens.kind, "oauth"), isNull(tokens.revokedAt)));
}

/**
 * Everything a person is signed in with: sessions, CLI and connector tokens, and connectors. A reset and a
 * removal both end these (04); organization tokens aren't anyone's, so they stay.
 */
export async function endSignIns(tx: Tx, personId: string, now: Date) {
  await tx.delete(sessions).where(eq(sessions.personId, personId));
  await tx
    .update(tokens)
    .set({ revokedAt: now })
    .where(
      and(eq(tokens.personId, personId), inArray(tokens.kind, ["cli", "oauth"]), isNull(tokens.revokedAt)),
    );
  await revokeGrants(tx, personId, now);
}
