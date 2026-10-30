import {
  AcceptInvite,
  ChangeRole,
  CreateInvite,
  CreateOrgToken,
  OrgSettings,
  PatchOrg,
} from "@artifacts/schema";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { newApiToken, randomSecret, sha256 } from "../auth/secrets.ts";
import { personView, startSession } from "../auth/sessions.ts";
import type { Db } from "../db/index.ts";
import {
  activity,
  artifactAccess,
  artifacts,
  invites,
  org,
  passkeys,
  passwords,
  people,
  projects,
  resetLinks,
  sessions,
  shareLinks,
  tokens,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { VERSION } from "../version.ts";
import { isUuid } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";
import { latestRelease } from "./updates.ts";

const HOUR = 3600_000;
const OWNER_LOCK = 7_316_003;
const INVITE_DAYS = 7;
const ORG_SCOPES_NEED = ["publish", "comment", "read", "manage", "data", "org"];

const actorOf = (caller: Caller) => {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person;
  throw new ApiError("forbidden", "You can't do that.");
};

export function peopleRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock } = deps;
  const inviteUrl = (secret: string) => `${env.publicUrl}/join/${secret}`;

  async function target(c: ApiContext) {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(people)
          .where(and(eq(people.orgId, c.get("org").id), eq(people.id, id), isNull(people.removedAt)))
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

  /** A token mustn't mint itself a browser session, which can do what no token may (04). */
  function guardTokenInvite(c: ApiContext, role: string) {
    if (c.get("caller").kind !== "person" && role !== "member" && role !== "reviewer") {
      throw new ApiError("forbidden", "Invite admins from the viewer, not with a token.");
    }
  }
  function guardTokenReset(c: ApiContext, target: { id: string; role: string }) {
    const caller = c.get("caller");
    if (caller.kind !== "person" && (target.role === "admin" || target.id === actorOf(caller).id)) {
      throw new ApiError("forbidden", "Issue this reset link from the viewer, not with a token.");
    }
  }

  /** Only an owner touches an owner, or an admin could take the deployment over (03). */
  function guardOwner(c: ApiContext, role: string) {
    if (role === "owner" && actorOf(c.get("caller")).role !== "owner") {
      throw new ApiError("forbidden", "Only an owner can do that to an owner.");
    }
  }

  routes.get("/api/org", { action: "org.read" }, async (c) => {
    const row = c.get("org");
    const latest = await latestRelease(deps);
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
    });
  });

  routes.patch("/api/org", { action: "org.manage" }, async (c) => {
    const body = await parseBody(c, PatchOrg);
    const current = c.get("org");
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

  routes.get("/api/people", { action: "people.read" }, async (c) => {
    const orgId = c.get("org").id;
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
          eq(invites.kind, outside ? "artifact" : "org"),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .orderBy(desc(invites.createdAt));
    const ids = rows.map((row) => row.id);
    const [withPassword, withPasskey, shares] = await Promise.all([
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
    ]);
    return c.json({
      people: rows.map((row) => ({
        ...personView(row),
        password: withPassword.some((entry) => entry.id === row.id),
        passkeys: withPasskey.filter((entry) => entry.id === row.id).length,
        shares: shares
          .filter((entry) => entry.personId === row.id)
          .map(({ title, permission }) => ({ title, permission })),
      })),
      invites: pending.map(({ invite, by }) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedBy: by,
        expiresAt: invite.expiresAt.toISOString(),
      })),
    });
  });

  routes.patch("/api/people/:id", { action: "people.manage" }, async (c) => {
    const { role } = await parseBody(c, ChangeRole);
    const person = await target(c as ApiContext);
    guardOwner(c as ApiContext, person.role);
    guardOwner(c as ApiContext, role);
    if (role === "outside" || person.role === "outside") {
      throw new ApiError("invalid", "Outside people get access per artifact, not a role.");
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${OWNER_LOCK})`);
      if (person.role === "owner" && role !== "owner" && (await ownerCount(tx, person.orgId)) <= 1) {
        throw new ApiError("conflict", "There must always be an owner.");
      }
      await tx.update(people).set({ role }).where(eq(people.id, person.id));
    });
    return c.json({ person: personView({ ...person, role }) });
  });

  routes.delete("/api/people/:id", { action: "people.manage" }, async (c) => {
    const person = await target(c as ApiContext);
    guardOwner(c as ApiContext, person.role);
    const now = clock.now();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${OWNER_LOCK})`);
      if (person.role === "owner" && (await ownerCount(tx, person.orgId)) <= 1) {
        throw new ApiError("conflict", "There must always be an owner.");
      }
      await tx.update(people).set({ removedAt: now }).where(eq(people.id, person.id));
      await tx.delete(sessions).where(eq(sessions.personId, person.id));
      await tx
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.personId, person.id), isNull(tokens.revokedAt)));
      // What they issued goes too, or an invite to a throwaway address would bring them straight back.
      await tx
        .update(invites)
        .set({ revokedAt: now })
        .where(and(eq(invites.createdBy, person.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)));
      await tx
        .update(resetLinks)
        .set({ usedAt: now })
        .where(and(eq(resetLinks.createdBy, person.id), isNull(resetLinks.usedAt)));
    });
    return c.json({ ok: true });
  });

  routes.post("/api/people/:id/reset-link", { action: "people.invite" }, async (c) => {
    const person = await target(c as ApiContext);
    guardOwner(c as ApiContext, person.role);
    guardTokenReset(c as ApiContext, person);
    const secret = randomSecret();
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + HOUR);
    await db.insert(resetLinks).values({
      id: Bun.randomUUIDv7(),
      orgId: person.orgId,
      personId: person.id,
      tokenHash: sha256(secret),
      createdBy: actorOf(c.get("caller")).id,
      createdAt: now,
      expiresAt,
    });
    return c.json({ url: `${env.publicUrl}/reset/${secret}`, expiresAt: expiresAt.toISOString() });
  });

  routes.post("/api/invites", { action: "people.invite" }, async (c) => {
    const body = await parseBody(c, CreateInvite);
    guardTokenInvite(c as ApiContext, body.role);
    const orgId = c.get("org").id;
    const [taken] = await db
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          eq(people.orgId, orgId),
          sql`lower(${people.email}) = lower(${body.email})`,
          isNull(people.removedAt),
        ),
      )
      .limit(1);
    if (taken) throw new ApiError("conflict", "That person is already here.");
    const secret = randomSecret();
    const now = clock.now();
    const [invite] = await db
      .insert(invites)
      .values({
        id: Bun.randomUUIDv7(),
        orgId,
        kind: "org",
        email: body.email,
        role: body.role,
        tokenHash: sha256(secret),
        createdBy: actorOf(c.get("caller")).id,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_DAYS * 24 * HOUR),
      })
      .returning();
    return c.json({
      invite: {
        id: invite?.id,
        email: body.email,
        role: body.role,
        expiresAt: invite?.expiresAt.toISOString(),
      },
      url: inviteUrl(secret),
    });
  });

  async function pendingInvite(c: ApiContext) {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(invites)
          .where(
            and(
              eq(invites.orgId, c.get("org").id),
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
    const row = await pendingInvite(c as ApiContext);
    await db.update(invites).set({ revokedAt: clock.now() }).where(eq(invites.id, row.id));
    return c.json({ ok: true });
  });

  // Secrets are stored hashed, so "copy it again" means a new link; the old one stops (02).
  routes.post("/api/invites/:id/link", { action: "people.invite" }, async (c) => {
    const row = await pendingInvite(c as ApiContext);
    const secret = randomSecret();
    await db
      .update(invites)
      .set({
        tokenHash: sha256(secret),
        expiresAt: new Date(clock.now().getTime() + INVITE_DAYS * 24 * HOUR),
      })
      .where(eq(invites.id, row.id));
    return c.json({ url: inviteUrl(secret) });
  });

  async function liveInvite(c: ApiContext) {
    const [row] = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.orgId, c.get("org").id),
          eq(invites.tokenHash, sha256(c.req.param("token") as string)),
        ),
      )
      .limit(1);
    if (!row || row.acceptedAt || row.revokedAt || row.expiresAt <= clock.now()) {
      throw new ApiError("gone", "This invite has expired or was already used. Ask for a new one.");
    }
    if (row.artifactId) {
      const [target] = await db
        .select({ deletedAt: artifacts.deletedAt })
        .from(artifacts)
        .where(eq(artifacts.id, row.artifactId))
        .limit(1);
      if (!target || target.deletedAt) throw new ApiError("gone", "This invite no longer works.");
    }
    return row;
  }

  routes.get("/api/invites/:token", { public: true }, async (c) => {
    const row = await liveInvite(c as ApiContext);
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
    return c.json({
      orgName: c.get("org").name,
      invitedBy: by?.name ?? "",
      role: row.role,
      email: row.email,
      ...(artifact ? { artifact } : {}),
    });
  });

  routes.post("/api/invites/:token/accept", { public: true }, async (c) => {
    const invite = await liveInvite(c as ApiContext);
    const body = await parseBody(c, AcceptInvite);
    const hash = body.password ? await Bun.password.hash(body.password, { algorithm: "argon2id" }) : null;
    const now = clock.now();
    const person = await db.transaction(async (tx) => {
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
          name: body.name,
          role: invite.role,
        })
        .returning();
      if (!row) throw new Error("no person row");
      if (hash) await tx.insert(passwords).values({ personId: row.id, orgId: invite.orgId, hash });
      if (invite.artifactId && invite.permission) {
        await tx.insert(artifactAccess).values({
          artifactId: invite.artifactId,
          orgId: invite.orgId,
          personId: row.id,
          permission: invite.permission,
          grantedBy: invite.createdBy,
        });
      }
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
    });
    await startSession(c, deps, person.orgId, person.id);
    return c.json({ person: personView(person) });
  });

  routes.get("/api/tokens", { action: "tokens.manage" }, async (c) => {
    const rows = await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.orgId, c.get("org").id), eq(tokens.kind, "org"), isNull(tokens.revokedAt)))
      .orderBy(desc(tokens.createdAt));
    return c.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        scopes: row.scopes,
        projectIds: row.projectIds,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      })),
    );
  });

  routes.post("/api/tokens", { action: "tokens.manage", recentAuth: true }, async (c) => {
    const body = await parseBody(c, CreateOrgToken);
    const secret = newApiToken();
    const [row] = await db
      .insert(tokens)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.get("org").id,
        kind: "org",
        name: body.name,
        tokenHash: sha256(secret),
        scopes: body.scopes.filter((scope) => ORG_SCOPES_NEED.includes(scope)),
        projectIds: body.projectIds ?? null,
        createdBy: actorOf(c.get("caller")).id,
        createdAt: clock.now(),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning({ id: tokens.id });
    return c.json({ id: row?.id, token: secret });
  });

  routes.delete("/api/tokens/:id", { action: "tokens.manage" }, async (c) => {
    const id = c.req.param("id");
    const revoked = isUuid(id)
      ? await db
          .update(tokens)
          .set({ revokedAt: clock.now() })
          .where(and(eq(tokens.orgId, c.get("org").id), eq(tokens.id, id), eq(tokens.kind, "org")))
          .returning({ id: tokens.id })
      : [];
    if (revoked.length === 0) throw new ApiError("not_found", "Not found.");
    return c.json({ ok: true });
  });

  routes.get("/api/shares", { action: "org.manage" }, async (c) => {
    const orgId = c.get("org").id;
    const now = clock.now();
    const [links, access] = await Promise.all([
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
    ]);
    return c.json({
      links: links
        .filter(({ link }) => !link.expiresAt || link.expiresAt > now)
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
    });
  });
}
