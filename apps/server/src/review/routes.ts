import { type Anchor, CreateComment, CreateDecision, CreateThread, EditComment } from "@artifacts/schema";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { artifactParam, findArtifact, isUuid } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import { type ApiContext, parseBody, type Routes } from "../api/routes.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { activity, blocks, comments, decisions, frames, threads, versions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { blobKey } from "../publish/blobs.ts";
import { cropAround } from "./crop.ts";

const MINUTE = 60_000;
const DAY = 24 * 3600_000;

type ThreadRow = typeof threads.$inferSelect;
type CommentRow = typeof comments.$inferSelect;

/** Who a comment is by. Tokens write as their person, shown as the agent when one was detected. */
function authorOf(caller: Caller, artifactId: string, agent: string | null | undefined) {
  if (caller.kind === "person") {
    return {
      authorPersonId: caller.person.id,
      authorGuestId: null,
      authorName: caller.person.name,
      agent: null,
    };
  }
  if (caller.kind === "cliToken") {
    return {
      authorPersonId: caller.person.id,
      authorGuestId: null,
      authorName: caller.person.name,
      agent: agent ?? null,
    };
  }
  if (caller.kind === "guest") {
    const link = caller.links.find((entry) => entry.artifactId === artifactId && entry.active);
    if (link)
      return { authorPersonId: null, authorGuestId: caller.guestId, authorName: link.name, agent: null };
  }
  throw new ApiError("forbidden", "You can't comment.");
}

const authorView = (row: { authorGuestId: string | null; authorName: string; agent?: string | null }) => ({
  name: row.agent ?? row.authorName,
  kind: row.agent ? ("agent" as const) : row.authorGuestId ? ("guest" as const) : ("person" as const),
});

export function reviewRoutes(routes: Routes, deps: Deps) {
  const { db, clock, bucket, limits, log } = deps;
  const artifact = artifactParam(deps);

  async function threadViews(rows: ThreadRow[]) {
    if (rows.length === 0) return [];
    const commentRows = await db
      .select()
      .from(comments)
      .where(
        inArray(
          comments.threadId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(comments.createdAt), asc(comments.id));
    return Promise.all(
      rows.map(async (row) => {
        const own = commentRows.filter((comment) => comment.threadId === row.id);
        return {
          id: row.id,
          n: row.n,
          pageKey: row.pageKey,
          anchor: row.anchor as Anchor | null,
          anchorState: row.anchorState,
          status: row.status,
          createdVersion: row.createdVersion,
          fixedVersion: row.fixedVersion,
          author: authorView(row),
          crop: row.cropKey ? await bucket.presignGet(row.cropKey) : null,
          comments: own.map(commentView),
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
        };
      }),
    );
  }

  const commentView = (row: CommentRow) => ({
    id: row.id,
    author: authorView(row),
    agent: row.agent,
    body: row.body,
    version: row.version,
    marksFixed: row.marksFixed,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  });

  const recordActivity = (
    c: ApiContext,
    row: { artifactId: string },
    kind: typeof activity.$inferInsert.kind,
    payload: Record<string, unknown>,
    agent: string | null = null,
  ) => {
    const caller = c.get("caller");
    return db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: c.get("org").id,
      artifactId: row.artifactId,
      actorPersonId: caller.kind === "person" || caller.kind === "cliToken" ? caller.person.id : null,
      actorGuestId: caller.kind === "guest" ? caller.guestId : null,
      agent,
      kind,
      payload,
      createdAt: clock.now(),
    });
  };

  async function threadParam(c: ApiContext) {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(threads)
          .where(and(eq(threads.orgId, c.get("org").id), eq(threads.id, id)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    return row;
  }
  /** A thread's permission is its artifact's. */
  const threadArtifact = async (c: ApiContext) => {
    const row = await threadParam(c);
    const found = await findArtifact(deps, row.orgId, row.artifactId);
    if (!found) throw new ApiError("not_found", "Not found.");
    return found;
  };

  routes.get("/api/artifacts/:id/threads", { action: "artifact.read", resource: artifact }, async (c) => {
    const status = c.req.query("status") ?? "all";
    const page = c.req.query("page");
    const version = Number(c.req.query("version"));
    const rows = await db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.artifactId, c.req.param("id") as string),
          status === "open" || status === "fixed" || status === "resolved"
            ? eq(threads.status, status)
            : undefined,
          page ? eq(threads.pageKey, page) : undefined,
          Number.isInteger(version) && version > 0 ? eq(threads.createdVersion, version) : undefined,
        ),
      )
      .orderBy(asc(threads.n));
    return etagJson(c, await threadViews(rows));
  });

  routes.post("/api/artifacts/:id/threads", { action: "artifact.comment", resource: artifact }, async (c) => {
    const body = await parseBody(c, CreateThread);
    const caller = c.get("caller");
    const artifactId = c.req.param("id") as string;
    const orgId = c.get("org").id;
    limits.hit(`comment:${JSON.stringify(caller)}`, 30, MINUTE);

    const [version] = await db
      .select({ id: versions.id })
      .from(versions)
      .where(
        and(eq(versions.artifactId, artifactId), eq(versions.n, body.version), isNull(versions.deletedAt)),
      )
      .limit(1);
    if (!version) throw new ApiError("invalid", "That version doesn't exist.");

    let render: string | null = null;
    if (body.anchor?.type === "frame") {
      const [frame] = await db
        .select({ renders: frames.renders })
        .from(frames)
        .where(
          and(
            eq(frames.versionId, version.id),
            eq(frames.pageKey, body.pageKey),
            eq(frames.frameKey, body.anchor.frameKey),
          ),
        )
        .limit(1);
      if (!frame) throw new ApiError("invalid", "That frame isn't in this version.");
      render = (frame.renders as { "2x": string })["2x"];
    } else if (body.anchor) {
      const [block] = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(
          and(
            eq(blocks.versionId, version.id),
            eq(blocks.pageKey, body.pageKey),
            eq(blocks.blockKey, body.anchor.blockKey),
          ),
        )
        .limit(1);
      if (!block) throw new ApiError("invalid", "That block isn't in this version.");
    }

    const author = authorOf(caller, artifactId, body.agent);
    const threadId = Bun.randomUUIDv7();
    const now = clock.now();
    const row = await db.transaction(async (tx) => {
      // Thread numbers are per artifact, and never reused.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${artifactId}, 1))`);
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`coalesce(max(${threads.n}), 0) + 1` })
        .from(threads)
        .where(eq(threads.artifactId, artifactId));
      const [thread] = await tx
        .insert(threads)
        .values({
          id: threadId,
          orgId,
          artifactId,
          n: next,
          pageKey: body.pageKey,
          anchor: body.anchor,
          createdVersion: body.version,
          authorPersonId: author.authorPersonId,
          authorGuestId: author.authorGuestId,
          authorName: author.authorName,
          createdAt: now,
        })
        .returning();
      await tx.insert(comments).values({
        id: Bun.randomUUIDv7(),
        threadId,
        orgId,
        ...author,
        body: body.body,
        version: body.version,
        createdAt: now,
      });
      return thread as ThreadRow;
    });

    let final = row;
    if (render && body.anchor?.type === "frame") {
      // The comment matters more than its picture: a failed crop is logged, not refused.
      try {
        const object = await bucket.get(blobKey(render));
        if (object) {
          const key = `crops/${threadId}.webp`;
          await bucket.put(key, await cropAround(object.body, body.anchor.x, body.anchor.y), {
            contentType: "image/webp",
          });
          const [updated] = await db
            .update(threads)
            .set({ cropKey: key })
            .where(eq(threads.id, threadId))
            .returning();
          if (updated) final = updated;
        }
      } catch (error) {
        log.warn("couldn't cut a crop", { thread: threadId, error: String(error) });
      }
    }
    await recordActivity(
      c as ApiContext,
      row,
      "commented",
      { thread: row.n, version: body.version },
      author.agent,
    );
    return c.json((await threadViews([final]))[0]);
  });

  routes.post(
    "/api/threads/:id/comments",
    { action: "artifact.comment", resource: threadArtifact },
    async (c) => {
      const body = await parseBody(c, CreateComment);
      const caller = c.get("caller");
      const thread = await threadParam(c as ApiContext);
      limits.hit(`comment:${JSON.stringify(caller)}`, 30, MINUTE);
      const resource = await findArtifact(deps, thread.orgId, thread.artifactId);
      if (!resource) throw new ApiError("not_found", "Not found.");
      const mayFix =
        caller.kind === "cliToken" || (caller.kind === "person" && caller.person.id === resource.publisherId);
      if (body.marksFixed && !mayFix)
        throw new ApiError("forbidden", "Only an agent or the publisher marks a thread fixed.");

      const author = authorOf(caller, thread.artifactId, body.agent);
      const latest = resource.row.latestVersion;
      const [fixer] = await db
        .select()
        .from(comments)
        .where(and(eq(comments.threadId, thread.id), eq(comments.marksFixed, true)))
        .orderBy(desc(comments.createdAt))
        .limit(1);
      const byFixer =
        fixer !== undefined &&
        fixer.authorPersonId === author.authorPersonId &&
        fixer.authorGuestId === author.authorGuestId &&
        fixer.agent === author.agent;

      const reopens = thread.status === "fixed" && !body.marksFixed && !byFixer;
      const [comment] = await db
        .insert(comments)
        .values({
          id: Bun.randomUUIDv7(),
          threadId: thread.id,
          orgId: thread.orgId,
          ...author,
          body: body.body,
          version: latest,
          marksFixed: body.marksFixed ?? false,
          createdAt: clock.now(),
        })
        .returning();
      if (body.marksFixed) {
        await db
          .update(threads)
          .set({ status: "fixed", fixedVersion: latest })
          .where(eq(threads.id, thread.id));
      } else if (reopens) {
        await db.update(threads).set({ status: "open", fixedVersion: null }).where(eq(threads.id, thread.id));
      }
      await recordActivity(
        c as ApiContext,
        thread,
        body.marksFixed ? "fixed" : reopens ? "reopened" : "replied",
        { thread: thread.n, version: latest },
        author.agent,
      );
      return c.json(commentView(comment as CommentRow));
    },
  );

  const setResolved = (resolved: boolean) => async (c: ApiContext) => {
    const thread = await threadParam(c);
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "Only people resolve threads.");
    const [row] = await db
      .update(threads)
      .set(
        resolved
          ? { status: "resolved", resolvedAt: clock.now(), resolvedBy: caller.person.id }
          : { status: "open", resolvedAt: null, resolvedBy: null, fixedVersion: null },
      )
      .where(eq(threads.id, thread.id))
      .returning();
    await recordActivity(c, thread, resolved ? "resolved" : "reopened", { thread: thread.n });
    return c.json((await threadViews([row as ThreadRow]))[0]);
  };
  routes.post("/api/threads/:id/resolve", { action: "thread.resolve", resource: threadArtifact }, (c) =>
    setResolved(true)(c as ApiContext),
  );
  routes.post("/api/threads/:id/reopen", { action: "thread.resolve", resource: threadArtifact }, (c) =>
    setResolved(false)(c as ApiContext),
  );

  routes.get("/api/threads/:id/crop", { action: "artifact.read", resource: threadArtifact }, async (c) => {
    const thread = await threadParam(c as ApiContext);
    if (!thread.cropKey) throw new ApiError("not_found", "Not found.");
    return c.redirect(await bucket.presignGet(thread.cropKey), 302);
  });

  /** Your own comment, within 24 hours (03). */
  async function ownComment(c: ApiContext) {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await db
          .select()
          .from(comments)
          .where(and(eq(comments.orgId, c.get("org").id), eq(comments.id, id)))
          .limit(1)
      : [];
    if (!row) throw new ApiError("not_found", "Not found.");
    const [thread] = await db.select().from(threads).where(eq(threads.id, row.threadId)).limit(1);
    const resource = thread && (await findArtifact(deps, thread.orgId, thread.artifactId));
    const caller = c.get("caller");
    if (!resource || !can(caller, "artifact.read", resource)) throw new ApiError("not_found", "Not found.");
    if (!can(caller, "artifact.comment", resource)) {
      if (resource.archivedAt)
        throw new ApiError("read_only", "This artifact is archived, so it's read-only.");
      throw new ApiError("forbidden", "You can't change this comment.");
    }
    const mine =
      caller.kind === "person" || caller.kind === "cliToken"
        ? row.authorPersonId === caller.person.id
        : caller.kind === "guest" && row.authorGuestId === caller.guestId;
    if (!mine) throw new ApiError("forbidden", "That's someone else's comment.");
    if (clock.now().getTime() - row.createdAt.getTime() > DAY) {
      throw new ApiError("forbidden", "Comments can only be changed for 24 hours.");
    }
    return { row, thread: thread as ThreadRow };
  }

  routes.patch("/api/comments/:id", { action: "artifact.comment", inHandler: true }, async (c) => {
    if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
    const { row } = await ownComment(c as ApiContext);
    const { body } = await parseBody(c, EditComment);
    const [updated] = await db
      .update(comments)
      .set({ body, editedAt: clock.now() })
      .where(eq(comments.id, row.id))
      .returning();
    return c.json(commentView(updated as CommentRow));
  });

  routes.delete("/api/comments/:id", { action: "artifact.comment", inHandler: true }, async (c) => {
    if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
    const { row, thread } = await ownComment(c as ApiContext);
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.threadId, thread.id));
    if (count <= 1) {
      await db.delete(comments).where(eq(comments.id, row.id));
      await db.delete(threads).where(eq(threads.id, thread.id));
      if (thread.cropKey) await bucket.delete(thread.cropKey).catch(() => {});
    } else {
      await db.delete(comments).where(eq(comments.id, row.id));
    }
    return c.json({ ok: true });
  });

  routes.post(
    "/api/artifacts/:id/decisions",
    { action: "artifact.decide", resource: artifact },
    async (c) => {
      const body = await parseBody(c, CreateDecision);
      const caller = c.get("caller");
      if (caller.kind !== "person") throw new ApiError("forbidden", "Only people decide.");
      const artifactId = c.req.param("id") as string;
      const [version] = await db
        .select({ n: versions.n })
        .from(versions)
        .where(
          and(eq(versions.artifactId, artifactId), eq(versions.n, body.version), isNull(versions.deletedAt)),
        )
        .limit(1);
      if (!version) throw new ApiError("invalid", "That version doesn't exist.");
      await db.insert(decisions).values({
        id: Bun.randomUUIDv7(),
        orgId: c.get("org").id,
        artifactId,
        version: body.version,
        personId: caller.person.id,
        kind: body.kind,
        note: body.note ?? null,
        createdAt: clock.now(),
      });
      await recordActivity(c as ApiContext, { artifactId }, body.kind, {
        version: body.version,
        note: body.note ?? null,
      });
      return c.json({ ok: true });
    },
  );

  routes.get("/api/artifacts/:id/status", { action: "artifact.read", resource: artifact }, async (c) => {
    const resource = await artifact(c as ApiContext);
    const artifactId = resource.id;
    const [latest] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.artifactId, artifactId))
      .orderBy(desc(decisions.createdAt))
      .limit(1);
    const rows = await db
      .select()
      .from(threads)
      .where(and(eq(threads.artifactId, artifactId), inArray(threads.status, ["open", "fixed"])))
      .orderBy(asc(threads.n));
    const views = await threadViews(rows);
    return etagJson(c, {
      version: resource.row.latestVersion,
      decision: latest?.kind ?? null,
      decisionVersion: latest?.version ?? null,
      note: latest?.note ?? null,
      open: views.filter((thread) => thread.status === "open"),
      fixedAwaiting: views.filter((thread) => thread.status === "fixed"),
    });
  });
}
