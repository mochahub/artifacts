import { CreateTeam, PatchTeam, PutTeamMember } from "@artifacts/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { can, type TeamResource } from "../auth/can.ts";
import { activity, artifactTeamAccess, people, teamMembers, teams } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { visibleTo } from "../library/visible.ts";
import { isUuid } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

type TeamRow = typeof teams.$inferSelect;

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

const personOf = (caller: Caller) => {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person;
  throw new ApiError("forbidden", "You can't do that.");
};

export function teamRoutes(routes: Routes, deps: Deps) {
  const { db, clock } = deps;

  async function findTeam(c: ApiContext): Promise<TeamResource & { row: TeamRow }> {
    const [row] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, c.get("org").id), eq(teams.slug, c.req.param("slug") as string)))
      .limit(1);
    if (!row) throw new ApiError("not_found", "Not found.");
    const leads = await db
      .select({ id: teamMembers.personId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, row.id), eq(teamMembers.role, "lead")));
    return { type: "team", id: row.id, leadIds: leads.map((lead) => lead.id), row };
  }

  const record = (c: ApiContext, kind: typeof activity.$inferInsert.kind, payload: Record<string, unknown>) =>
    db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: c.get("org").id,
      actorPersonId: personOf(c.get("caller")).id,
      kind,
      payload,
      createdAt: clock.now(),
    });

  const sizes = async (ids: string[]) => {
    if (ids.length === 0) return [];
    return db
      .select({ teamId: teamMembers.teamId, count: sql<number>`count(*)::int` })
      .from(teamMembers)
      .innerJoin(people, eq(people.id, teamMembers.personId))
      .where(and(inArray(teamMembers.teamId, ids), isNull(people.removedAt)))
      .groupBy(teamMembers.teamId);
  };

  const view = (row: TeamRow, members: number) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    members,
  });

  routes.get("/api/teams", { action: "team.read" }, async (c) => {
    const rows = await db
      .select()
      .from(teams)
      .where(eq(teams.orgId, c.get("org").id))
      .orderBy(asc(teams.name));
    const counts = await sizes(rows.map((row) => row.id));
    const me = personOf(c.get("caller")).id;
    const mine = await db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.personId, me));
    return c.json({
      teams: rows.map((row) => ({
        ...view(row, counts.find((entry) => entry.teamId === row.id)?.count ?? 0),
        role: mine.find((entry) => entry.teamId === row.id)?.role ?? null,
      })),
    });
  });

  routes.post("/api/teams", { action: "team.manage" }, async (c) => {
    const body = await parseBody(c, CreateTeam);
    const slug = body.slug ?? (slugOf(body.name) || `team-${Bun.randomUUIDv7().slice(-8)}`);
    const created = await db
      .insert(teams)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.get("org").id,
        slug,
        name: body.name,
        description: body.description ?? null,
        createdBy: personOf(c.get("caller")).id,
        createdAt: clock.now(),
      })
      .onConflictDoNothing()
      .returning();
    const [row] = created;
    if (!row) throw new ApiError("conflict", "There's already a team with that name.");
    await record(c as ApiContext, "team_created", { team: row.name });
    return c.json({ team: view(row, 0) });
  });

  routes.get("/api/teams/:slug", { action: "team.read" }, async (c) => {
    const team = await findTeam(c as ApiContext);
    const caller = c.get("caller");
    // Starts from what the caller can see, so a team's page can't name work hidden from them.
    const visible = await visibleTo(deps, c.get("org").id, caller);
    const granted = await db
      .select({ artifactId: artifactTeamAccess.artifactId, permission: artifactTeamAccess.permission })
      .from(artifactTeamAccess)
      .where(eq(artifactTeamAccess.teamId, team.id));
    // People search is for browsers, and a member list is the same directory by another route.
    const members =
      caller.kind === "person"
        ? await db
            .select({ person: people, role: teamMembers.role })
            .from(teamMembers)
            .innerJoin(people, eq(people.id, teamMembers.personId))
            .where(and(eq(teamMembers.teamId, team.id), isNull(people.removedAt)))
            .orderBy(asc(people.name))
        : [];
    const [count] = await sizes([team.id]);
    return c.json({
      team: view(team.row, count?.count ?? 0),
      members: members.map(({ person, role }) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        role,
        orgRole: person.role,
      })),
      shared: visible.flatMap(({ row, projectSlug }) => {
        const grant = granted.find((entry) => entry.artifactId === row.id);
        return grant
          ? [{ id: row.id, project: projectSlug, slug: row.slug, title: row.title, level: grant.permission }]
          : [];
      }),
      permissions: {
        manage: can(caller, "team.manage", { type: "org" }),
        members: can(caller, "team.members", team),
      },
    });
  });

  routes.patch("/api/teams/:slug", { action: "team.manage" }, async (c) => {
    const team = await findTeam(c as ApiContext);
    const body = await parseBody(c, PatchTeam);
    const updated = await db
      .update(teams)
      .set({
        name: body.name ?? team.row.name,
        slug: body.slug ?? team.row.slug,
        description: body.description === undefined ? team.row.description : body.description,
      })
      .where(eq(teams.id, team.id))
      .returning()
      .catch((error: { code?: string; cause?: { code?: string } }) => {
        if ((error.cause?.code ?? error.code) === "23505") {
          throw new ApiError("conflict", "There's already a team with that name.");
        }
        throw error;
      });
    const [count] = await sizes([team.id]);
    return c.json({ team: view(updated[0] as TeamRow, count?.count ?? 0) });
  });

  routes.delete("/api/teams/:slug", { action: "team.manage" }, async (c) => {
    const team = await findTeam(c as ApiContext);
    await db.transaction(async (tx) => {
      await tx.delete(artifactTeamAccess).where(eq(artifactTeamAccess.teamId, team.id));
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
      await tx.delete(teams).where(eq(teams.id, team.id));
    });
    await record(c as ApiContext, "team_deleted", { team: team.row.name });
    return c.json({ ok: true });
  });

  const teamResource = (c: ApiContext) => findTeam(c);

  async function memberParam(c: ApiContext) {
    const id = c.req.param("personId");
    const [person] = isUuid(id)
      ? await db
          .select()
          .from(people)
          .where(and(eq(people.orgId, c.get("org").id), eq(people.id, id), isNull(people.removedAt)))
          .limit(1)
      : [];
    if (!person) throw new ApiError("not_found", "Not found.");
    return person;
  }

  routes.put(
    "/api/teams/:slug/members/:personId",
    { action: "team.members", resource: teamResource },
    async (c) => {
      const team = await findTeam(c as ApiContext);
      const person = await memberParam(c as ApiContext);
      const { role } = await parseBody(c, PutTeamMember);
      // Leading a team hands out its access, which a role capped at commenting shouldn't do.
      if (role === "lead" && (person.role === "outside" || person.role === "reviewer")) {
        throw new ApiError("invalid", "Only members of the organization can lead a team.");
      }
      const added = await db
        .insert(teamMembers)
        .values({
          teamId: team.id,
          personId: person.id,
          orgId: team.row.orgId,
          role,
          addedBy: personOf(c.get("caller")).id,
          createdAt: clock.now(),
        })
        .onConflictDoNothing()
        .returning({ id: teamMembers.personId });
      if (added.length === 0) {
        await db
          .update(teamMembers)
          .set({ role })
          .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.personId, person.id)));
      } else {
        await record(c as ApiContext, "team_member_added", { team: team.row.name, person: person.name });
      }
      return c.json({ member: { id: person.id, name: person.name, role } });
    },
  );

  routes.delete(
    "/api/teams/:slug/members/:personId",
    { action: "team.members", resource: teamResource },
    async (c) => {
      const team = await findTeam(c as ApiContext);
      const person = await memberParam(c as ApiContext);
      const removed = await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.personId, person.id)))
        .returning({ id: teamMembers.personId });
      if (removed.length === 0) throw new ApiError("not_found", "Not found.");
      await record(c as ApiContext, "team_member_removed", { team: team.row.name, person: person.name });
      return c.json({ ok: true });
    },
  );
}
