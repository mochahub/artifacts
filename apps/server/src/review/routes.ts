import {
  COMMENT_MAX,
  CreateComment,
  CreateDecision,
  CreateThread,
  DAY_MS,
  EditComment,
} from "@artifacts/schema";
import { and, eq, sql } from "drizzle-orm";
import { findArtifact, type LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { comments, threads } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { isUuid } from "../http/params.ts";
import { artifactParam } from "../http/resources.ts";
import type { ApiContext, RouteRequest, Routes } from "../http/routes.ts";
import { type CommentRow, commentView, type Review, type ThreadRow } from "./service.ts";

/** A page key, or the words around a quote. */
const MAX_KEY_CHARS = 500;

const notFound = () => new ApiError("not_found", "Not found.");
type CommentResource = LoadedArtifact & { thread: ThreadRow; comment: CommentRow };

export function reviewRoutes(routes: Routes, deps: Deps, review: Review) {
  const { db, clock, bucket } = deps;
  const artifact = artifactParam(deps);

  /** The `:id` thread, guarded as its artifact. */
  async function threadParam(c: ApiContext): Promise<LoadedArtifact & { thread: ThreadRow }> {
    const id = c.req.param("id");
    const [thread] = isUuid(id)
      ? await db
          .select()
          .from(threads)
          .where(and(eq(threads.orgId, c.get("org").id), eq(threads.id, id)))
          .limit(1)
      : [];
    const found = thread && (await findArtifact(deps, thread.orgId, thread.artifactId));
    if (!thread || !found) throw notFound();
    return { ...found, thread };
  }

  /** The `:id` comment, guarded by reading its artifact: whether it may change is the author's question. */
  async function commentParam(c: ApiContext): Promise<CommentResource> {
    const id = c.req.param("id");
    const [found] = isUuid(id)
      ? await db
          .select({ comment: comments, thread: threads })
          .from(comments)
          .innerJoin(threads, eq(threads.id, comments.threadId))
          .where(and(eq(comments.orgId, c.get("org").id), eq(comments.id, id)))
          .limit(1)
      : [];
    const resource = found && (await findArtifact(deps, found.thread.orgId, found.thread.artifactId));
    if (!found || !resource) throw notFound();
    return { ...resource, ...found };
  }

  routes.get("/api/artifacts/:id/threads", { action: "artifact.read", resource: artifact }, async (c) => {
    const { views } = await review.listThreads(c.var.resource.id, {
      status: c.req.query("status"),
      page: c.req.query("page"),
      version: Number(c.req.query("version")),
    });
    return etagJson(c, views);
  });

  routes.post("/api/artifacts/:id/threads", { action: "artifact.comment", resource: artifact }, async (c) => {
    const body = await parseBody(c, CreateThread);
    // The schema leaves these open, and anyone who may comment, a guest included, can send them.
    const { anchor } = body;
    if (
      body.pageKey.length > MAX_KEY_CHARS ||
      (anchor?.type === "text" &&
        (anchor.quote.exact.length > COMMENT_MAX ||
          anchor.quote.prefix.length > MAX_KEY_CHARS ||
          anchor.quote.suffix.length > MAX_KEY_CHARS))
    ) {
      throw new ApiError("invalid", "That page or quote is too long.");
    }
    return c.json(await review.startThread(c.var, c.var.resource, body));
  });

  routes.post(
    "/api/threads/:id/comments",
    { action: "artifact.comment", resource: threadParam },
    async (c) => {
      const body = await parseBody(c, CreateComment);
      return c.json(await review.replyTo(c.var, c.var.resource, c.var.resource.thread, body));
    },
  );

  routes.post("/api/threads/:id/resolve", { action: "thread.resolve", resource: threadParam }, async (c) =>
    c.json(await review.setResolved(c.var, c.var.resource.thread, true)),
  );
  routes.post("/api/threads/:id/reopen", { action: "thread.resolve", resource: threadParam }, async (c) =>
    c.json(await review.setResolved(c.var, c.var.resource.thread, false)),
  );

  routes.get("/api/threads/:id/crop", { action: "artifact.read", resource: threadParam }, async (c) => {
    const { thread } = c.var.resource;
    if (!thread.cropKey) throw notFound();
    return c.redirect(await bucket.presignGet(thread.cropKey), 302);
  });

  /** Your own comment, within 24 hours (03). */
  const commentRoute = { action: "artifact.read", resource: commentParam } as const;
  const ownComment = (c: RouteRequest<Caller, CommentResource>) => {
    const { caller, resource } = c.var;
    const { comment } = resource;
    if (!can(caller, "artifact.comment", resource)) {
      if (resource.archivedAt)
        throw new ApiError("read_only", "This artifact is archived, so it's read-only.");
      throw new ApiError("forbidden", "You can't change this comment.");
    }
    const mine =
      caller.kind === "person" || caller.kind === "cliToken"
        ? comment.authorPersonId === caller.person.id
        : caller.kind === "guest" && comment.authorGuestId === caller.guestId;
    if (!mine) throw new ApiError("forbidden", "That's someone else's comment.");
    if (clock.now().getTime() - comment.createdAt.getTime() > DAY_MS) {
      throw new ApiError("forbidden", "Comments can only be changed for 24 hours.");
    }
    return resource;
  };

  routes.patch("/api/comments/:id", commentRoute, async (c) => {
    const { comment, thread } = ownComment(c);
    const { body } = await parseBody(c, EditComment);
    const [updated] = await db
      .update(comments)
      .set({ body, editedAt: clock.now() })
      .where(eq(comments.id, comment.id))
      .returning();
    void deps.events.emit(thread.artifactId, "comment", { thread: thread.n });
    return c.json(commentView(updated as CommentRow));
  });

  routes.delete("/api/comments/:id", commentRoute, async (c) => {
    const { comment, thread } = ownComment(c);
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.threadId, thread.id));
    await db.delete(comments).where(eq(comments.id, comment.id));
    if (count <= 1) {
      await db.delete(threads).where(eq(threads.id, thread.id));
      if (thread.cropKey) await bucket.delete(thread.cropKey).catch(() => {});
    }
    void deps.events.emit(thread.artifactId, "comment", { thread: thread.n });
    return c.json({ ok: true });
  });

  routes.post(
    "/api/artifacts/:id/decisions",
    { action: "artifact.decide", resource: artifact },
    async (c) => {
      const body = await parseBody(c, CreateDecision);
      if ((body.note?.length ?? 0) > COMMENT_MAX) throw new ApiError("invalid", "That note is too long.");
      await review.decide(c.var, c.var.resource, body);
      return c.json({ ok: true });
    },
  );

  routes.get("/api/artifacts/:id/status", { action: "artifact.read", resource: artifact }, async (c) =>
    etagJson(c, await review.status(c.var, c.var.resource)),
  );
}
