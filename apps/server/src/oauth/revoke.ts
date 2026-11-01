import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import { oauthGrants, tokens } from "../db/schema.ts";

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];

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
