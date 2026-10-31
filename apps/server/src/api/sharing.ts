import { AddAccess, CreateShareLink, GuestName, PatchArtifact } from "@artifacts/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { randomSecret, sha256 } from "../auth/secrets.ts";
import { GUEST_COOKIE, isSecureRequest, setSessionCookie } from "../auth/sessions.ts";
import {
  activity,
  artifactAccess,
  artifacts,
  frames,
  guestLinks,
  guests,
  invites,
  people,
  projects,
  shareLinks,
  versions,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { artifactParam, isUuid } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import { type ApiContext, parseBody, type Routes } from "./routes.ts";

const DAY = 24 * 3600_000;
const GUEST_DAYS = 90;
const EXPIRES = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY };

export function sharingRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock, limits } = deps;
  const artifact = artifactParam(deps);

  /** Sharing writes on an archived artifact answer read_only, like every other write (03). */
  const writable = async (c: ApiContext) => {
    const resource = await artifact(c);
    if (resource.archivedAt) throw new ApiError("read_only", "This artifact is archived, so it's read-only.");
    return resource;
  };
  const actor = (c: ApiContext) => {
    const caller = c.get("caller");
    if (caller.kind === "person" || caller.kind === "cliToken") return caller.person;
    throw new ApiError("forbidden", "You can't do that.");
  };

  routes.patch("/api/artifacts/:id", { action: "artifact.manage", resource: artifact }, async (c) => {
    const resource = await writable(c as ApiContext);
    const { visibility } = await parseBody(c, PatchArtifact);
    if (visibility) await db.update(artifacts).set({ visibility }).where(eq(artifacts.id, resource.id));
    return c.json({ visibility: visibility ?? resource.visibility });
  });

  routes.get("/api/artifacts/:id/access", { action: "artifact.share", resource: artifact }, async (c) => {
    const id = c.req.param("id") as string;
    const now = clock.now();
    const [added, links] = await Promise.all([
      db
        .select({ person: people, permission: artifactAccess.permission })
        .from(artifactAccess)
        .innerJoin(people, eq(people.id, artifactAccess.personId))
        .where(and(eq(artifactAccess.artifactId, id), isNull(people.removedAt)))
        .orderBy(asc(people.name)),
      db
        .select()
        .from(shareLinks)
        .where(and(eq(shareLinks.artifactId, id), isNull(shareLinks.revokedAt))),
    ]);
    return c.json({
      people: added.map(({ person, permission }) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        permission,
      })),
      links: links
        .filter((link) => !link.expiresAt || link.expiresAt > now)
        .map((link) => ({
          id: link.id,
          permission: link.permission,
          expiresAt: link.expiresAt?.toISOString() ?? null,
          createdAt: link.createdAt.toISOString(),
        })),
    });
  });

  routes.post("/api/artifacts/:id/access", { action: "artifact.share", resource: artifact }, async (c) => {
    const resource = await writable(c as ApiContext);
    const { email, permission } = await parseBody(c, AddAccess);
    const orgId = c.get("org").id;
    const me = actor(c as ApiContext);
    const [person] = await db
      .select()
      .from(people)
      .where(
        and(eq(people.orgId, orgId), sql`lower(${people.email}) = lower(${email})`, isNull(people.removedAt)),
      )
      .limit(1);
    const isMember = person && ["owner", "admin", "member"].includes(person.role);
    if (permission === "publish" && !isMember) {
      throw new ApiError("invalid", "Only members of the organization can publish.");
    }
    const now = clock.now();
    await db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId,
      artifactId: resource.id,
      actorPersonId: me.id,
      kind: "shared",
      payload: { permission },
      createdAt: now,
    });
    // Access a token hands out can comment but not decide or resolve, until a person grants it
    // again (04). A person's grant, new or a change in the Share sheet, is that confirmation.
    const viaToken = c.get("caller").kind !== "person";
    if (person) {
      await db
        .insert(artifactAccess)
        .values({
          artifactId: resource.id,
          orgId,
          personId: person.id,
          permission,
          grantedBy: me.id,
          viaToken,
        })
        .onConflictDoUpdate({
          target: [artifactAccess.artifactId, artifactAccess.personId],
          set: {
            permission,
            grantedBy: me.id,
            // A token repeating the grant leaves a person's confirmation alone; changing it is unconfirmed.
            viaToken: viaToken
              ? sql`case when ${artifactAccess.permission} = ${permission} then ${artifactAccess.viaToken} else true end`
              : false,
          },
        });
      return c.json({ added: { id: person.id, name: person.name, permission } });
    }
    const secret = randomSecret();
    await db.insert(invites).values({
      id: Bun.randomUUIDv7(),
      orgId,
      kind: "artifact",
      email,
      role: "outside",
      artifactId: resource.id,
      permission,
      viaToken,
      tokenHash: sha256(secret),
      createdBy: me.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * DAY),
    });
    return c.json({ url: `${env.publicUrl}/join/${secret}` });
  });

  routes.delete(
    "/api/artifacts/:id/access/:personId",
    { action: "artifact.share", resource: artifact },
    async (c) => {
      const resource = await writable(c as ApiContext);
      const removed = isUuid(c.req.param("personId"))
        ? await db
            .delete(artifactAccess)
            .where(
              and(
                eq(artifactAccess.artifactId, resource.id),
                eq(artifactAccess.personId, c.req.param("personId") as string),
              ),
            )
            .returning({ id: artifactAccess.personId })
        : [];
      if (removed.length === 0) throw new ApiError("not_found", "Not found.");
      return c.json({ ok: true });
    },
  );

  routes.post("/api/artifacts/:id/links", { action: "artifact.share", resource: artifact }, async (c) => {
    const resource = await writable(c as ApiContext);
    if (!c.get("org").settings.linkSharing) {
      throw new ApiError("forbidden", "Link sharing is turned off for this organization.");
    }
    const { permission, expiresIn } = await parseBody(c, CreateShareLink);
    const secret = randomSecret();
    const now = clock.now();
    const expiresAt = expiresIn ? new Date(now.getTime() + EXPIRES[expiresIn]) : null;
    const [link] = await db
      .insert(shareLinks)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.get("org").id,
        artifactId: resource.id,
        tokenHash: sha256(secret),
        permission,
        createdBy: actor(c as ApiContext).id,
        createdAt: now,
        expiresAt,
      })
      .returning();
    return c.json({
      link: { id: link?.id, permission, expiresAt: expiresAt?.toISOString() ?? null },
      url: `${env.publicUrl}/s/${secret}`,
    });
  });

  routes.delete(
    "/api/artifacts/:id/links/:linkId",
    { action: "artifact.share", resource: artifact },
    async (c) => {
      const resource = await writable(c as ApiContext);
      const linkId = c.req.param("linkId");
      const revoked = isUuid(linkId)
        ? await db
            .update(shareLinks)
            .set({ revokedAt: clock.now() })
            .where(and(eq(shareLinks.id, linkId), eq(shareLinks.artifactId, resource.id)))
            .returning({ id: shareLinks.id })
        : [];
      if (revoked.length === 0) throw new ApiError("not_found", "Not found.");
      return c.json({ ok: true });
    },
  );

  /** A link that can still be used, with what it points at. Deleted artifacts stop links at once (SPEC §5.5). */
  async function liveLink(c: ApiContext) {
    const [row] = await db
      .select({ link: shareLinks, artifact: artifacts, project: projects.slug, sharedBy: people.name })
      .from(shareLinks)
      .innerJoin(artifacts, eq(artifacts.id, shareLinks.artifactId))
      .innerJoin(projects, eq(projects.id, artifacts.projectId))
      .innerJoin(people, eq(people.id, shareLinks.createdBy))
      .where(
        and(
          eq(shareLinks.orgId, c.get("org").id),
          eq(shareLinks.tokenHash, sha256(c.req.param("token") as string)),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.link.revokedAt ||
      row.artifact.deletedAt ||
      !c.get("org").settings.linkSharing ||
      (row.link.expiresAt && row.link.expiresAt <= clock.now())
    ) {
      throw new ApiError("gone", "This link no longer works.");
    }
    return row;
  }

  const ogHash = async (artifactId: string, n: number) => {
    const [version] = await db
      .select({ files: versions.files })
      .from(versions)
      .where(and(eq(versions.artifactId, artifactId), eq(versions.n, n)))
      .limit(1);
    return (version?.files as Record<string, { hash: string }> | undefined)?.["__og.webp"]?.hash ?? null;
  };

  routes.get("/api/s/:token", { public: true }, async (c) => {
    const { link, artifact: row, project, sharedBy } = await liveLink(c as ApiContext);
    const [first] = await db
      .select({ renders: frames.renders })
      .from(frames)
      .innerJoin(versions, eq(versions.id, frames.versionId))
      .where(and(eq(versions.artifactId, row.id), eq(versions.n, row.latestVersion)))
      .orderBy(asc(frames.y), asc(frames.x))
      .limit(1);
    const guest = getCookie(c, GUEST_COOKIE);
    let named = false;
    if (guest) {
      const [known] = await db
        .select({ id: guestLinks.guestId })
        .from(guestLinks)
        .innerJoin(guests, eq(guests.id, guestLinks.guestId))
        .where(and(eq(guests.tokenHash, sha256(guest)), eq(guestLinks.shareLinkId, link.id)))
        .limit(1);
      named = known !== undefined;
    }
    return c.json({
      artifact: {
        id: row.id,
        project,
        slug: row.slug,
        title: row.title,
        cover: first ? { renderHash: (first.renders as { thumb: string }).thumb } : { title: row.title },
      },
      permission: link.permission,
      needsName: !named,
      sharedBy,
    });
  });

  routes.get("/api/s/:token/cover", { public: true }, async (c) => {
    const { artifact: row } = await liveLink(c as ApiContext);
    const hash = await ogHash(row.id, row.latestVersion);
    if (hash) return c.redirect(await deps.bucket.presignGet(`blobs/${hash}`), 302);
    const [first] = await db
      .select({ renders: frames.renders })
      .from(frames)
      .innerJoin(versions, eq(versions.id, frames.versionId))
      .where(and(eq(versions.artifactId, row.id), eq(versions.n, row.latestVersion)))
      .orderBy(asc(frames.y), asc(frames.x))
      .limit(1);
    if (!first) throw new ApiError("not_found", "Not found.");
    return c.redirect(
      await deps.bucket.presignGet(`blobs/${(first.renders as { "2x": string })["2x"]}`),
      302,
    );
  });

  routes.post("/api/s/:token/guest", { public: true }, async (c) => {
    limits.hit(`guest:${deps.clientIp(c)}`, 20, 3600_000);
    const { link } = await liveLink(c as ApiContext);
    const { name } = await parseBody(c, GuestName);
    const orgId = c.get("org").id;
    const now = clock.now();

    let secret = getCookie(c, GUEST_COOKIE);
    let [guest] = secret
      ? await db
          .select()
          .from(guests)
          .where(and(eq(guests.orgId, orgId), eq(guests.tokenHash, sha256(secret))))
          .limit(1)
      : [];
    if (!guest) {
      secret = randomSecret();
      [guest] = await db
        .insert(guests)
        .values({ id: Bun.randomUUIDv7(), orgId, tokenHash: sha256(secret), lastSeenAt: now, createdAt: now })
        .returning();
    }
    if (!guest || !secret) throw new Error("no guest row");
    // 90 days from first use, and never past the link's own expiry (02).
    const limit = now.getTime() + GUEST_DAYS * DAY;
    const expiresAt = new Date(link.expiresAt ? Math.min(limit, link.expiresAt.getTime()) : limit);
    await db
      .insert(guestLinks)
      .values({ guestId: guest.id, orgId, shareLinkId: link.id, name, createdAt: now, expiresAt })
      .onConflictDoUpdate({ target: [guestLinks.guestId, guestLinks.shareLinkId], set: { name } });
    setSessionCookie(c, GUEST_COOKIE, secret, GUEST_DAYS, isSecureRequest(c, await deps.origins()));
    return c.json({ guest: { id: guest.id, name } });
  });
}
