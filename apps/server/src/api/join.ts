import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import {
  activity,
  artifactAccess,
  artifacts,
  invites,
  passwords,
  people,
  projectAccess,
  teamMembers,
  teams,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Deps } from "./deps.ts";

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];
export type InviteRow = typeof invites.$inferSelect;

/** An invite that can still be used. Secrets are stored hashed, so a link looks it up by hash. */
export async function findLiveInvite(
  deps: Deps,
  orgId: string,
  by: { tokenHash: string } | { id: string },
): Promise<InviteRow> {
  const where: SQL = "id" in by ? eq(invites.id, by.id) : eq(invites.tokenHash, by.tokenHash);
  const [row] = await deps.db
    .select()
    .from(invites)
    .where(and(eq(invites.orgId, orgId), where))
    .limit(1);
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt <= deps.clock.now()) {
    throw new ApiError("gone", "This invite has expired or was already used. Ask for a new one.");
  }
  if (row.artifactId) {
    const [target] = await deps.db
      .select({ deletedAt: artifacts.deletedAt })
      .from(artifacts)
      .where(eq(artifacts.id, row.artifactId))
      .limit(1);
    if (!target || target.deletedAt) throw new ApiError("gone", "This invite no longer works.");
  }
  return row;
}

/** Makes the person an invite was for, with everything it promised. A password is one way in; Google is another. */
export async function acceptInvite(
  tx: Tx,
  invite: InviteRow,
  values: { name: string; passwordHash: string | null; now: Date },
) {
  const { name, passwordHash, now } = values;
  // Single use, even if the link is opened twice at once.
  const taken = await tx
    .update(invites)
    .set({ acceptedAt: now })
    .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
    .returning({ id: invites.id });
  if (taken.length === 0) throw new ApiError("gone", "This invite was already used.");
  const [existing] = await tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.orgId, invite.orgId),
        sql`lower(${people.email}) = lower(${invite.email})`,
        isNull(people.removedAt),
      ),
    )
    .limit(1);
  if (existing) throw new ApiError("conflict", "That email already has an account. Sign in instead.");
  const [row] = await tx
    .insert(people)
    .values({
      id: Bun.randomUUIDv7(),
      orgId: invite.orgId,
      email: invite.email,
      name,
      role: invite.role,
    })
    .returning();
  if (!row) throw new Error("no person row");
  if (passwordHash) {
    await tx.insert(passwords).values({ personId: row.id, orgId: invite.orgId, hash: passwordHash });
  }
  if (invite.artifactId && invite.permission) {
    await tx.insert(artifactAccess).values({
      artifactId: invite.artifactId,
      orgId: invite.orgId,
      personId: row.id,
      permission: invite.permission,
      grantedBy: invite.createdBy,
      viaToken: invite.viaToken,
    });
  }
  if (invite.projectId && invite.projectPermission) {
    await tx.insert(projectAccess).values({
      id: Bun.randomUUIDv7(),
      orgId: invite.orgId,
      projectId: invite.projectId,
      personId: row.id,
      permission: invite.projectPermission,
      grantedBy: invite.createdBy,
    });
  }
  await joinTeams(tx, invite.orgId, row.id, invite.teamIds, invite.createdBy);
  await tx.insert(activity).values({
    id: Bun.randomUUIDv7(),
    orgId: invite.orgId,
    artifactId: invite.artifactId,
    actorPersonId: row.id,
    kind: "joined",
    payload: { role: invite.role },
    createdAt: now,
  });
  return row;
}

/** A team deleted since the list was made is skipped, not an error for the person joining. */
export async function joinTeams(
  tx: Tx,
  orgId: string,
  personId: string,
  teamIds: string[] | null,
  addedBy: string,
) {
  if (!teamIds?.length) return;
  const live = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), inArray(teams.id, teamIds)));
  if (live.length === 0) return;
  await tx.insert(teamMembers).values(live.map((team) => ({ teamId: team.id, personId, orgId, addedBy })));
}
