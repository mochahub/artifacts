import { AddProjectAccess, RestrictProject, SetProjectAccess } from "@artifacts/schema";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { can, capFor } from "../auth/can.ts";
import { randomSecret, sha256 } from "../auth/secrets.ts";
import {
  activity,
  artifacts,
  invites,
  people,
  projectAccess,
  projects,
  shareLinks,
  teamMembers,
  teams,
  tokens,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid, type LoadedProject, projectGrants, projectParam } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

const DAY = 24 * 3600_000;
const INVITE_DAYS = 7;
/** Enough names to recognise who a restriction shuts out, without listing the organization. */
const NAMES_SHOWN = 5;

const actorId = (c: ApiContext) => {
  const caller = c.get("caller");
  if (caller.kind === "person") return caller.person.id;
  throw new ApiError("forbidden", "This needs a signed-in browser.");
};

export function projectRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock } = deps;
  const project = projectParam(deps);

  const record = (c: ApiContext, place: LoadedProject, payload: Record<string, unknown>) =>
    db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: place.row.orgId,
      projectId: place.id,
      actorPersonId: actorId(c),
      kind: "project_access_changed",
      payload: { project: place.row.name, ...payload },
      createdAt: clock.now(),
    });

  const outsideLevel = (person: { role: string }, permission: string) => {
    if (person.role === "outside" && (permission === "publish" || permission === "manage")) {
      throw new ApiError("invalid", "Only members of the organization can publish or manage.");
    }
  };

  /** What restricting a project would do, for the confirmation. */
  async function impactOf(place: LoadedProject) {
    const now = clock.now();
    const holders = new Set(place.grants.map((grant) => grant.personId));
    const [everyone, links, pending, broad] = await Promise.all([
      db
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(
          and(
            eq(people.orgId, place.row.orgId),
            isNull(people.removedAt),
            inArray(people.role, ["member", "reviewer"]),
          ),
        )
        .orderBy(asc(people.name)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(shareLinks)
        .innerJoin(artifacts, eq(artifacts.id, shareLinks.artifactId))
        .where(
          and(
            eq(artifacts.projectId, place.id),
            isNull(shareLinks.revokedAt),
            isNull(artifacts.deletedAt),
            or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(invites)
        .leftJoin(artifacts, eq(artifacts.id, invites.artifactId))
        .where(
          and(
            or(eq(artifacts.projectId, place.id), eq(invites.projectId, place.id)),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, now),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(tokens)
        .where(
          and(
            eq(tokens.orgId, place.row.orgId),
            eq(tokens.kind, "org"),
            isNull(tokens.projectIds),
            isNull(tokens.revokedAt),
          ),
        ),
    ]);
    const losing = everyone.filter((person) => !holders.has(person.id));
    return {
      loses: losing.length,
      names: losing.slice(0, NAMES_SHOWN).map((person) => person.name),
      links: links[0]?.n ?? 0,
      invites: pending[0]?.n ?? 0,
      tokens: broad[0]?.n ?? 0,
    };
  }

  routes.get(
    "/api/projects/:slug/access",
    { action: "project.access.read", resource: project },
    async (c) => {
      const place = await project(c as ApiContext);
      const orgId = place.row.orgId;
      // Who's in a team, and everyone's addresses, are the directory: a token gets the outline.
      const directory = can(c.get("caller"), "people.search", { type: "org" });
      const [own, granted, grants, staff] = await Promise.all([
        db
          .select({ person: people, permission: projectAccess.permission })
          .from(projectAccess)
          .innerJoin(people, eq(people.id, projectAccess.personId))
          .where(and(eq(projectAccess.projectId, place.id), isNull(people.removedAt)))
          .orderBy(asc(people.name)),
        db
          .select({
            team: teams,
            permission: projectAccess.permission,
            members: sql<number>`(
            select count(*)::int from ${teamMembers}
            inner join ${people} on ${people.id} = ${teamMembers.personId}
            where ${teamMembers.teamId} = ${teams.id} and ${people.removedAt} is null
          )`,
          })
          .from(projectAccess)
          .innerJoin(teams, eq(teams.id, projectAccess.teamId))
          .where(eq(projectAccess.projectId, place.id))
          .orderBy(asc(teams.name)),
        projectGrants(deps, orgId, { projectIds: [place.id] }),
        db
          .select()
          .from(people)
          .where(
            and(eq(people.orgId, orgId), isNull(people.removedAt), inArray(people.role, ["owner", "admin"])),
          )
          .orderBy(asc(people.name)),
      ]);
      const direct = new Set(own.map(({ person }) => person.id));
      const list = (grants.get(place.id) ?? []).filter((grant) => !direct.has(grant.personId));
      const ids = [...new Set(list.map((grant) => grant.personId))];
      const throughTeams = ids.length
        ? await db
            .select()
            .from(people)
            .where(and(inArray(people.id, ids), isNull(people.removedAt)))
            .orderBy(asc(people.name))
        : [];
      const rowFor = (person: typeof people.$inferSelect) => ({
        id: person.id,
        name: person.name,
        ...(directory ? { email: person.email } : {}),
        role: person.role,
      });
      const admins = staff.map((person) => person.id);
      return c.json({
        project: { slug: place.row.slug, name: place.row.name, restricted: place.restricted },
        people: own.map(({ person, permission }) => ({
          ...rowFor(person),
          permission,
          capped: capFor(person, permission) !== permission,
        })),
        teams: granted.map(({ team, permission, members }) => ({
          id: team.id,
          slug: team.slug,
          name: team.name,
          permission,
          members,
        })),
        inherited: !directory
          ? []
          : [
              ...staff
                .filter((person) => !direct.has(person.id))
                .map((person) => ({
                  ...rowFor(person),
                  level: "manage" as const,
                  via: "role" as const,
                  sources: [],
                  capped: false,
                })),
              ...throughTeams
                .filter((person) => !admins.includes(person.id))
                .map((person) => {
                  const mine = list.filter((grant) => grant.personId === person.id);
                  const level = place.grants.find((grant) => grant.personId === person.id)?.level ?? "view";
                  return {
                    ...rowFor(person),
                    level: capFor(person, level),
                    via: "grant" as const,
                    sources: mine.flatMap((grant) =>
                      grant.kind === "project" && grant.team
                        ? [{ kind: "team", slug: grant.team.slug, name: grant.team.name }]
                        : [],
                    ),
                    capped: capFor(person, level) !== level,
                  };
                }),
            ],
        impact: await impactOf(place),
        canChange: can(c.get("caller"), "project.access.write", place),
      });
    },
  );

  routes.patch("/api/projects/:slug/access", { action: "project.update", resource: project }, async (c) => {
    const place = await project(c as ApiContext);
    const { restricted, revokeLinks } = await parseBody(c, RestrictProject);
    const now = clock.now();
    await db.transaction(async (tx) => {
      await tx.update(projects).set({ restricted }).where(eq(projects.id, place.id));
      if (!revokeLinks) return;
      const inside = tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.projectId, place.id));
      await tx
        .update(shareLinks)
        .set({ revokedAt: now })
        .where(and(inArray(shareLinks.artifactId, inside), isNull(shareLinks.revokedAt)));
      await tx
        .update(invites)
        .set({ revokedAt: now })
        .where(
          and(
            or(inArray(invites.artifactId, inside), eq(invites.projectId, place.id)),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        );
    });
    await record(c as ApiContext, place, { restricted, revokedLinks: revokeLinks === true });
    return c.json({ restricted });
  });

  /** By address, as the artifact's sheet does: someone here gets the grant, anyone else an outside invite. */
  routes.post(
    "/api/projects/:slug/access",
    { action: "project.access.write", resource: project },
    async (c) => {
      const place = await project(c as ApiContext);
      const { email, permission } = await parseBody(c, AddProjectAccess);
      const orgId = place.row.orgId;
      const by = actorId(c as ApiContext);
      const [person] = await db
        .select()
        .from(people)
        .where(
          and(
            eq(people.orgId, orgId),
            sql`lower(${people.email}) = lower(${email})`,
            isNull(people.removedAt),
          ),
        )
        .limit(1);
      if (person) {
        outsideLevel(person, permission);
        await grantPerson(place, person.id, permission, by);
        await record(c as ApiContext, place, { person: person.name, permission });
        return c.json({ added: { id: person.id, name: person.name, permission } });
      }
      outsideLevel({ role: "outside" }, permission);
      const secret = randomSecret();
      const now = clock.now();
      await db.insert(invites).values({
        id: Bun.randomUUIDv7(),
        orgId,
        kind: "project",
        email,
        role: "outside",
        projectId: place.id,
        projectPermission: permission,
        tokenHash: sha256(secret),
        createdBy: by,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY),
      });
      return c.json({ url: `${env.publicUrl}/join/${secret}` });
    },
  );

  const grantPerson = (place: LoadedProject, personId: string, permission: string, by: string) =>
    db
      .insert(projectAccess)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: place.row.orgId,
        projectId: place.id,
        personId,
        permission: permission as "view",
        grantedBy: by,
        createdAt: clock.now(),
      })
      .onConflictDoUpdate({
        target: [projectAccess.projectId, projectAccess.personId],
        set: { permission: permission as "view", grantedBy: by },
      });

  /** `person:<id>` or `team:<id>`, which can't collide with anything else in the path. */
  async function subjectOf(c: ApiContext, place: LoadedProject) {
    const [, kind, id] = /^(person|team):(.+)$/.exec(c.req.param("subject") ?? "") ?? [];
    if (!isUuid(id)) throw new ApiError("not_found", "Not found.");
    if (kind === "person") {
      const [person] = await db
        .select()
        .from(people)
        .where(and(eq(people.orgId, place.row.orgId), eq(people.id, id), isNull(people.removedAt)))
        .limit(1);
      if (!person) throw new ApiError("not_found", "Not found.");
      return { person };
    }
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, place.row.orgId), eq(teams.id, id)))
      .limit(1);
    if (!team) throw new ApiError("not_found", "Not found.");
    return { team };
  }

  routes.put(
    "/api/projects/:slug/access/:subject",
    { action: "project.access.write", resource: project },
    async (c) => {
      const place = await project(c as ApiContext);
      const { permission } = await parseBody(c, SetProjectAccess);
      const subject = await subjectOf(c as ApiContext, place);
      const by = actorId(c as ApiContext);
      if (subject.person) {
        outsideLevel(subject.person, permission);
        await grantPerson(place, subject.person.id, permission, by);
      } else {
        await db
          .insert(projectAccess)
          .values({
            id: Bun.randomUUIDv7(),
            orgId: place.row.orgId,
            projectId: place.id,
            teamId: subject.team.id,
            permission,
            grantedBy: by,
            createdAt: clock.now(),
          })
          .onConflictDoUpdate({
            target: [projectAccess.projectId, projectAccess.teamId],
            set: { permission, grantedBy: by },
          });
      }
      await record(c as ApiContext, place, {
        ...(subject.person ? { person: subject.person.name } : { team: subject.team?.name }),
        permission,
      });
      return c.json({ permission });
    },
  );

  routes.delete(
    "/api/projects/:slug/access/:subject",
    { action: "project.access.write", resource: project },
    async (c) => {
      const place = await project(c as ApiContext);
      const subject = await subjectOf(c as ApiContext, place);
      const removed = await db
        .delete(projectAccess)
        .where(
          and(
            eq(projectAccess.projectId, place.id),
            subject.person
              ? eq(projectAccess.personId, subject.person.id)
              : eq(projectAccess.teamId, subject.team.id),
          ),
        )
        .returning({ id: projectAccess.id });
      if (removed.length === 0) throw new ApiError("not_found", "Not found.");
      await record(c as ApiContext, place, {
        ...(subject.person ? { person: subject.person.name } : { team: subject.team?.name }),
        permission: null,
      });
      return c.json({ ok: true });
    },
  );
}
