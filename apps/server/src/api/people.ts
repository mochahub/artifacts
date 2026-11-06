import type {
  InviteCreated,
  InvitePreview,
  OrgInfo,
  OrgTokenCreated,
  OrgTokenList,
  PeopleList,
  PeopleSearch,
  PersonResponse,
} from "@artifacts/schema";
import {
  AcceptInvite,
  ChangeRole,
  CreateInvite,
  CreateOrgToken,
  OrgSettings,
  PatchOrg,
  RESET_HOURS,
} from "@artifacts/schema";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { projectGrants } from "../auth/access.ts";
import type { Caller, CallerPerson } from "../auth/caller.ts";
import { mayTouchRole, runsTheOrg, tokenLimits } from "../auth/can.ts";
import {
  acceptInvite,
  createInvite,
  findLiveInvite,
  findPersonByEmail,
  inviteExpiry,
  inviteUrl,
} from "../auth/invites.ts";
import { isLiveLink } from "../auth/links.ts";
import { endSignIns } from "../auth/revoke.ts";
import { newApiToken, randomSecret, sha256 } from "../auth/secrets.ts";
import { personView, startSession } from "../auth/sessions.ts";
import type { Db } from "../db/index.ts";
import { lockOwners } from "../db/locks.ts";
import {
  artifactAccess,
  artifacts,
  identities,
  invites,
  org,
  passkeys,
  passwords,
  people,
  projectAccess,
  projects,
  removedIdentities,
  resetLinks,
  shareLinks,
  teamMembers,
  teams,
  tokens,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import type { ApiContext, RouteRequest, Routes } from "../http/routes.ts";
import { VERSION } from "../version.ts";
import { releaseCheck } from "./updates.ts";

const SEARCH_RESULTS = 20;
const SEARCHES_PER_MINUTE = 60;

type PersonRow = typeof people.$inferSelect;

export function peopleRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock } = deps;
  const latestRelease = releaseCheck(deps);

  async function target(c: RouteRequest) {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(people)
          .where(and(eq(people.orgId, c.var.org.id), eq(people.id, id), isNull(people.removedAt)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    return row;
  }

  const ownerCount = async (tx: Pick<Db, "select">, orgId: string) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(people)
      .where(and(eq(people.orgId, orgId), eq(people.role, "owner"), isNull(people.removedAt)));
    return row?.n ?? 0;
  };

  function guardTokenInvite(caller: Caller, role: string, teamIds: string[] | null | undefined) {
    if (!tokenLimits.invites(caller, role)) {
      throw new ApiError("forbidden", "Invite admins from the viewer, not with a token.");
    }
    if (!tokenLimits.joinsTeams(caller, teamIds)) {
      throw new ApiError("forbidden", "Add people to teams from the viewer, not with a token.");
    }
  }
  async function guardTokenReset(caller: Caller, target: PersonRow) {
    if (caller.kind === "person") return;
    const [lead] = await db
      .select({ id: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.personId, target.id), eq(teamMembers.role, "lead")))
      .limit(1);
    const grants = await projectGrants(deps, target.orgId, { personId: target.id });
    const managesProject = [...grants.values()].flat().some((grant) => grant.level === "manage");
    if (!tokenLimits.resets(caller, { ...target, leadsTeam: lead !== undefined, managesProject })) {
      throw new ApiError("forbidden", "Issue this reset link from the viewer, not with a token.");
    }
  }

  /** What they issued goes too, or an invite to a throwaway address would bring them straight back. */
  async function revokeIssued(tx: Pick<Db, "update">, personId: string, now: Date) {
    await tx
      .update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.createdBy, personId), isNull(invites.acceptedAt), isNull(invites.revokedAt)));
    await tx
      .update(resetLinks)
      .set({ usedAt: now })
      .where(and(eq(resetLinks.createdBy, personId), isNull(resetLinks.usedAt)));
  }

  function guardOwner(actor: CallerPerson, role: CallerPerson["role"]) {
    if (!mayTouchRole(actor, role)) throw new ApiError("forbidden", "Only an owner can do that to an owner.");
  }

  routes.get("/api/org", { action: "org.read" }, async (c) => {
    const row = c.var.org;
    const latest = await latestRelease();
    return c.json({
      name: row.name,
      newVersion: latest && Bun.semver.order(latest, VERSION) > 0 ? latest : null,
      settings: row.settings,
      domains: {
        home: row.homeDomain,
        publicUrl: env.publicUrl,
        moreUrls: env.viewerOrigins.filter((origin) => origin !== env.publicUrl),
        contentUrl: env.contentUrl,
      },
    } satisfies OrgInfo);
  });

  routes.patch("/api/org", { action: "org.manage" }, async (c) => {
    const body = await parseBody(c, PatchOrg);
    const current = c.var.org;
    const settings = OrgSettings.parse({
      ...current.settings,
      ...body.settings,
      limits: { ...current.settings.limits, ...body.settings?.limits },
    });
    await db
      .update(org)
      .set({ name: body.name ?? current.name, settings })
      .where(eq(org.id, current.id));
    return c.json({ name: body.name ?? current.name, settings });
  });

  routes.get("/api/people/search", { action: "people.search" }, async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return c.json({ people: [] });
    deps.limits.hit(`people-search:${c.var.caller.person.id}`, SEARCHES_PER_MINUTE, 60_000);
    const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await db
      .select()
      .from(people)
      .where(
        and(
          eq(people.orgId, c.var.org.id),
          isNull(people.removedAt),
          or(ilike(people.name, like), ilike(people.email, like)),
        ),
      )
      .orderBy(asc(people.name))
      .limit(SEARCH_RESULTS);
    return c.json({ people: rows.map(personView) } satisfies PeopleSearch);
  });

  routes.get("/api/people", { action: "people.read" }, async (c) => {
    const orgId = c.var.org.id;
    const outside = c.req.query("kind") === "outside";
    const rows = await db
      .select()
      .from(people)
      .where(
        and(
          eq(people.orgId, orgId),
          isNull(people.removedAt),
          outside ? eq(people.role, "outside") : ne(people.role, "outside"),
        ),
      )
      .orderBy(asc(people.createdAt));
    const now = clock.now();
    const pending = await db
      .select({ invite: invites, by: people.name })
      .from(invites)
      .innerJoin(people, eq(people.id, invites.createdBy))
      .where(
        and(
          eq(invites.orgId, orgId),
          outside ? inArray(invites.kind, ["artifact", "project"]) : eq(invites.kind, "org"),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .orderBy(desc(invites.createdAt));
    const ids = rows.map((row) => row.id);
    const [withPassword, withPasskey, shares, memberships, onProjects, linked] = await Promise.all([
      ids.length
        ? db.select({ id: passwords.personId }).from(passwords).where(inArray(passwords.personId, ids))
        : [],
      ids.length
        ? db.select({ id: passkeys.personId }).from(passkeys).where(inArray(passkeys.personId, ids))
        : [],
      outside && ids.length
        ? db
            .select({
              personId: artifactAccess.personId,
              title: artifacts.title,
              permission: artifactAccess.permission,
            })
            .from(artifactAccess)
            .innerJoin(artifacts, eq(artifacts.id, artifactAccess.artifactId))
            .where(inArray(artifactAccess.personId, ids))
        : [],
      ids.length
        ? db
            .select({
              personId: teamMembers.personId,
              slug: teams.slug,
              name: teams.name,
              role: teamMembers.role,
            })
            .from(teamMembers)
            .innerJoin(teams, eq(teams.id, teamMembers.teamId))
            .where(inArray(teamMembers.personId, ids))
            .orderBy(asc(teams.name))
        : [],
      ids.length
        ? db
            .select({
              personId: projectAccess.personId,
              slug: projects.slug,
              name: projects.name,
              permission: projectAccess.permission,
            })
            .from(projectAccess)
            .innerJoin(projects, eq(projects.id, projectAccess.projectId))
            .where(inArray(projectAccess.personId, ids))
            .orderBy(asc(projects.name))
        : [],
      ids.length
        ? db.select({ id: identities.personId }).from(identities).where(inArray(identities.personId, ids))
        : [],
    ]);
    return c.json({
      people: rows.map((row) => ({
        ...personView(row),
        password: withPassword.some((entry) => entry.id === row.id),
        passkeys: withPasskey.filter((entry) => entry.id === row.id).length,
        google: linked.some((entry) => entry.id === row.id),
        shares: shares
          .filter((entry) => entry.personId === row.id)
          .map(({ title, permission }) => ({ title, permission })),
        teams: memberships
          .filter((entry) => entry.personId === row.id)
          .map(({ slug, name, role }) => ({ slug, name, role })),
        projects: onProjects
          .filter((entry) => entry.personId === row.id)
          .map(({ slug, name, permission }) => ({ slug, name, permission })),
      })),
      invites: pending.map(({ invite, by }) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedBy: by,
        expiresAt: invite.expiresAt.toISOString(),
      })),
    } satisfies PeopleList);
  });

  routes.patch("/api/people/:id", { action: "people.manage" }, async (c) => {
    const { role } = await parseBody(c, ChangeRole);
    const person = await target(c);
    guardOwner(c.var.caller.person, person.role);
    guardOwner(c.var.caller.person, role);
    if (role === "outside" || person.role === "outside") {
      throw new ApiError("invalid", "Outside people get access per artifact, not a role.");
    }
    await db.transaction(async (tx) => {
      await lockOwners(tx);
      if (person.role === "owner" && role !== "owner" && (await ownerCount(tx, person.orgId)) <= 1) {
        throw new ApiError("conflict", "There must always be an owner.");
      }
      await tx.update(people).set({ role }).where(eq(people.id, person.id));
      // Losing admin ends what they issued, as removal does: an admin invite or a reset link
      // from before would otherwise hand the same power straight back.
      if (runsTheOrg(person) && !runsTheOrg({ role })) await revokeIssued(tx, person.id, clock.now());
    });
    return c.json({ person: personView({ ...person, role }) });
  });

  routes.delete("/api/people/:id", { action: "people.manage" }, async (c) => {
    const person = await target(c);
    guardOwner(c.var.caller.person, person.role);
    const now = clock.now();
    await db.transaction(async (tx) => {
      await lockOwners(tx);
      if (person.role === "owner" && (await ownerCount(tx, person.orgId)) <= 1) {
        throw new ApiError("conflict", "There must always be an owner.");
      }
      await tx.update(people).set({ removedAt: now }).where(eq(people.id, person.id));
      await endSignIns(tx, person.id, now);
      await tx.delete(teamMembers).where(eq(teamMembers.personId, person.id));
      await tx.delete(projectAccess).where(eq(projectAccess.personId, person.id));
      const linked = await tx.delete(identities).where(eq(identities.personId, person.id)).returning();
      if (linked.length > 0) {
        await tx
          .insert(removedIdentities)
          .values(
            linked.map(({ orgId, provider, subject }) => ({
              orgId,
              provider,
              subjectHash: sha256(subject),
              createdAt: now,
            })),
          )
          .onConflictDoNothing();
      }

      await revokeIssued(tx, person.id, now);
      // What they created for others outlives their account unless it ends with it: an organization
      // token keeps acting as the organization, and a share link keeps admitting guests (04).
      await tx
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.kind, "org"), eq(tokens.createdBy, person.id), isNull(tokens.revokedAt)));
      // A guest's access is read from the link on every request, so this ends theirs too (02).
      await tx
        .update(shareLinks)
        .set({ revokedAt: now })
        .where(and(eq(shareLinks.createdBy, person.id), isNull(shareLinks.revokedAt)));
    });
    return c.json({ ok: true });
  });

  routes.post("/api/people/:id/reset-link", { action: "people.invite" }, async (c) => {
    const person = await target(c);
    guardOwner(c.var.caller.person, person.role);
    await guardTokenReset(c.var.caller, person);
    const secret = randomSecret();
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + RESET_HOURS * 3600_000);
    await db.insert(resetLinks).values({
      id: Bun.randomUUIDv7(),
      orgId: person.orgId,
      personId: person.id,
      tokenHash: sha256(secret),
      createdBy: c.var.caller.person.id,
      createdAt: now,
      expiresAt,
    });
    return c.json({ url: `${env.publicUrl}/reset/${secret}`, expiresAt: expiresAt.toISOString() });
  });

  routes.post("/api/invites", { action: "people.invite" }, async (c) => {
    const body = await parseBody(c, CreateInvite);
    guardTokenInvite(c.var.caller, body.role, body.teamIds);
    const orgId = c.var.org.id;
    if (body.teamIds?.length) {
      const known = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.orgId, orgId), inArray(teams.id, body.teamIds)));
      if (known.length < new Set(body.teamIds).size)
        throw new ApiError("invalid", "That team doesn't exist.");
    }
    if (await findPersonByEmail(db, orgId, body.email)) {
      throw new ApiError("conflict", "That person is already here.");
    }
    const { invite, url } = await createInvite(deps, {
      orgId,
      kind: "org",
      email: body.email,
      role: body.role,
      teamIds: body.teamIds?.length ? body.teamIds : null,
      createdBy: c.var.caller.person.id,
    });
    return c.json({
      invite: {
        id: invite.id,
        email: body.email,
        role: body.role,
        expiresAt: invite.expiresAt.toISOString(),
      },
      url,
    } satisfies InviteCreated);
  });

  async function pendingInvite(c: RouteRequest) {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(invites)
          .where(
            and(
              eq(invites.orgId, c.var.org.id),
              eq(invites.id, id),
              isNull(invites.acceptedAt),
              isNull(invites.revokedAt),
            ),
          )
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    return row;
  }

  routes.delete("/api/invites/:id", { action: "people.manage" }, async (c) => {
    const row = await pendingInvite(c);
    await db.update(invites).set({ revokedAt: clock.now() }).where(eq(invites.id, row.id));
    return c.json({ ok: true });
  });

  // Secrets are stored hashed, so "copy it again" means a new link; the old one stops (02).
  routes.post("/api/invites/:id/link", { action: "people.invite" }, async (c) => {
    const row = await pendingInvite(c);
    // A new link is a new way in, so a token gets no more here than when it makes the invite.
    guardTokenInvite(c.var.caller, row.role, row.teamIds);
    const secret = randomSecret();
    await db
      .update(invites)
      .set({ tokenHash: sha256(secret), expiresAt: inviteExpiry(clock.now()) })
      .where(eq(invites.id, row.id));
    return c.json({ url: inviteUrl(env, secret) });
  });

  const liveInvite = (c: ApiContext) =>
    findLiveInvite(deps, c.var.org.id, { tokenHash: sha256(c.req.param("token") as string) });

  routes.get("/api/invites/:token", { public: true }, async (c) => {
    const row = await liveInvite(c);
    const [by] = await db
      .select({ name: people.name })
      .from(people)
      .where(eq(people.id, row.createdBy))
      .limit(1);
    const [artifact] = row.artifactId
      ? await db
          .select({ title: artifacts.title })
          .from(artifacts)
          .where(eq(artifacts.id, row.artifactId))
          .limit(1)
      : [];
    const [project] = row.projectId
      ? await db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).limit(1)
      : [];
    const joining = row.teamIds?.length
      ? await db.select({ name: teams.name }).from(teams).where(inArray(teams.id, row.teamIds))
      : [];
    return c.json({
      orgName: c.var.org.name,
      invitedBy: by?.name ?? "",
      role: row.role,
      email: row.email,
      ...(artifact ? { artifact } : {}),
      ...(project ? { project } : {}),
      ...(joining.length > 0 ? { teams: joining.map((team) => team.name) } : {}),
    } satisfies InvitePreview);
  });

  routes.post("/api/invites/:token/accept", { public: true }, async (c) => {
    const invite = await liveInvite(c);
    const body = await parseBody(c, AcceptInvite);
    const hash = body.password ? await Bun.password.hash(body.password, { algorithm: "argon2id" }) : null;
    const person = await db.transaction((tx) =>
      acceptInvite(tx, invite, { name: body.name, passwordHash: hash, now: clock.now() }),
    );
    await startSession(c, deps, person.orgId, person.id);
    return c.json({ person: personView(person) } satisfies PersonResponse);
  });

  routes.get("/api/tokens", { action: "tokens.manage" }, async (c) => {
    const rows = await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.orgId, c.var.org.id), eq(tokens.kind, "org"), isNull(tokens.revokedAt)))
      .orderBy(desc(tokens.createdAt));
    return c.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        scopes: row.scopes,
        projectIds: row.projectIds,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      })) satisfies OrgTokenList,
    );
  });

  routes.post("/api/tokens", { action: "tokens.manage", recentAuth: true }, async (c) => {
    const body = await parseBody(c, CreateOrgToken);
    const secret = newApiToken();
    const [row] = await db
      .insert(tokens)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.var.org.id,
        kind: "org",
        name: body.name,
        tokenHash: sha256(secret),
        scopes: body.scopes,
        projectIds: body.projectIds ?? null,
        createdBy: c.var.caller.person.id,
        createdAt: clock.now(),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning({ id: tokens.id });
    if (!row) throw new Error("no token row");
    return c.json({ id: row.id, token: secret } satisfies OrgTokenCreated);
  });

  routes.delete("/api/tokens/:id", { action: "tokens.manage" }, async (c) => {
    const id = c.req.param("id");
    const revoked = isUuid(id)
      ? await db
          .update(tokens)
          .set({ revokedAt: clock.now() })
          .where(and(eq(tokens.orgId, c.var.org.id), eq(tokens.id, id), eq(tokens.kind, "org")))
          .returning({ id: tokens.id })
      : [];
    if (revoked.length === 0) throw new ApiError("not_found", "Not found.");
    return c.json({ ok: true });
  });

  routes.get("/api/shares", { action: "org.manage" }, async (c) => {
    const orgId = c.var.org.id;
    const now = clock.now();
    const [links, access, onProjects, inTeams] = await Promise.all([
      db
        .select({ link: shareLinks, title: artifacts.title, project: projects.slug, slug: artifacts.slug })
        .from(shareLinks)
        .innerJoin(artifacts, eq(artifacts.id, shareLinks.artifactId))
        .innerJoin(projects, eq(projects.id, artifacts.projectId))
        .where(and(eq(shareLinks.orgId, orgId), isNull(shareLinks.revokedAt))),
      db
        .select({ person: people, permission: artifactAccess.permission, title: artifacts.title })
        .from(artifactAccess)
        .innerJoin(people, eq(people.id, artifactAccess.personId))
        .innerJoin(artifacts, eq(artifacts.id, artifactAccess.artifactId))
        .where(and(eq(artifactAccess.orgId, orgId), eq(people.role, "outside"), isNull(people.removedAt))),
      db
        .select({ person: people, permission: projectAccess.permission, project: projects.name })
        .from(projectAccess)
        .innerJoin(people, eq(people.id, projectAccess.personId))
        .innerJoin(projects, eq(projects.id, projectAccess.projectId))
        .where(and(eq(projectAccess.orgId, orgId), eq(people.role, "outside"), isNull(people.removedAt))),
      db
        .select({ person: people, team: teams.name })
        .from(teamMembers)
        .innerJoin(people, eq(people.id, teamMembers.personId))
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(and(eq(teamMembers.orgId, orgId), eq(people.role, "outside"), isNull(people.removedAt))),
    ]);
    return c.json({
      links: links
        .filter(({ link }) => isLiveLink(link, now))
        .map(({ link, title, project, slug }) => ({
          id: link.id,
          artifactId: link.artifactId,
          title,
          project,
          slug,
          permission: link.permission,
          expiresAt: link.expiresAt?.toISOString() ?? null,
        })),
      people: access.map(({ person, permission, title }) => ({
        email: person.email,
        name: person.name,
        permission,
        title,
      })),
      projects: onProjects.map(({ person, permission, project }) => ({
        email: person.email,
        name: person.name,
        permission,
        project,
      })),
      teams: inTeams.map(({ person, team }) => ({ email: person.email, name: person.name, team })),
    });
  });
}
