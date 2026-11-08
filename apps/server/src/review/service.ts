import {
  type ActivityKind,
  type ArtifactReviewStatus,
  agentLabel,
  type Comment,
  type CreateComment,
  type CreateDecision,
  type CreateThread,
  MINUTE_MS,
  type Thread,
} from "@artifacts/schema";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { LoadedArtifact } from "../auth/access.ts";
import { type Asker, agentOf, type Caller, limiterKey } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { lockArtifact } from "../db/locks.ts";
import {
  activity,
  artifacts,
  blocks,
  boardVersions,
  comments,
  decisions,
  frames,
  threads,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey, cropKey } from "../layout.ts";
import { audienceOf } from "../library/audience.ts";
import { notifyReply } from "../push/notify.ts";
import { cropAround } from "./crop.ts";

const COMMENTS_PER_MINUTE = 30;

export type ThreadRow = typeof threads.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
type Person = Extract<Caller, { kind: "person" }>;

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
      agent: agentOf(caller, agent),
    };
  }
  if (caller.kind === "orgToken")
    return {
      authorPersonId: caller.createdBy,
      authorGuestId: null,
      authorName: "Agent",
      agent: agentOf(caller, agent),
    };
  if (caller.kind === "guest") {
    const link = caller.links.find((entry) => entry.artifactId === artifactId && entry.active);
    if (link)
      return { authorPersonId: null, authorGuestId: caller.guestId, authorName: link.name, agent: null };
  }
  throw new ApiError("forbidden", "You can't comment.");
}

const authorView = (row: { authorGuestId: string | null; authorName: string; agent?: string | null }) => ({
  name: row.agent ? agentLabel(row.authorName, row.agent) : row.authorName,
  kind: row.agent ? ("agent" as const) : row.authorGuestId ? ("guest" as const) : ("person" as const),
});

export const commentView = (row: CommentRow): Comment => ({
  id: row.id,
  author: authorView(row),
  agent: row.agent ? agentLabel(row.authorName, row.agent) : null,
  body: row.body,
  version: row.version,
  marksFixed: row.marksFixed,
  createdAt: row.createdAt.toISOString(),
  editedAt: row.editedAt?.toISOString() ?? null,
});

export type Review = ReturnType<typeof createReview>;

/** Threads, comments and decisions, for the API and the hosted MCP alike (03, "Review"). */
export function createReview(deps: Deps) {
  const { db, clock, bucket, limits, log } = deps;

  async function threadViews(rows: ThreadRow[]): Promise<Thread[]> {
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
          anchor: row.anchor,
          anchorState:
            row.movedFromVersion !== null && row.anchorState === "ok"
              ? ("moved_version" as const)
              : row.anchorState,
          status: row.status,
          createdVersion: row.createdVersion,
          fixedVersion: row.fixedVersion,
          // Threads don't store an agent; the comment that opened one does.
          author: authorView(own[0] ?? row),
          crop: row.cropKey ? await bucket.presignGet(row.cropKey) : null,
          comments: own.map(commentView),
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
        };
      }),
    );
  }

  const record = (
    { org, caller }: Asker,
    artifactId: string,
    kind: ActivityKind,
    payload: Record<string, unknown>,
    agent: string | null = null,
  ) =>
    db.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: org.id,
      artifactId,
      actorPersonId: caller.kind === "person" || caller.kind === "cliToken" ? caller.person.id : null,
      actorGuestId: caller.kind === "guest" ? caller.guestId : null,
      agent,
      kind,
      payload,
      createdAt: clock.now(),
    });

  /** 30 comments a minute per caller (04, "Rate limits"). */
  const countComment = (caller: Caller) =>
    limits.hit(`comment:${limiterKey(caller) ?? caller.kind}`, COMMENTS_PER_MINUTE, MINUTE_MS);

  async function listThreads(
    artifactId: string,
    filter: { status?: string; page?: string; version?: number } = {},
  ) {
    const { status = "all", page, version } = filter;
    const rows = await db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.artifactId, artifactId),
          status === "open" || status === "fixed" || status === "resolved"
            ? eq(threads.status, status)
            : undefined,
          page ? eq(threads.pageKey, page) : undefined,
          Number.isInteger(version) && (version as number) > 0
            ? eq(threads.createdVersion, version as number)
            : undefined,
        ),
      )
      .orderBy(asc(threads.n));
    return { rows, views: await threadViews(rows) };
  }

  async function liveVersion(artifactId: string, n: number) {
    const [version] = await db
      .select({ id: versions.id, n: versions.n })
      .from(versions)
      .where(and(eq(versions.artifactId, artifactId), eq(versions.n, n), isNull(versions.deletedAt)))
      .limit(1);
    if (!version) throw new ApiError("invalid", "That version doesn't exist.");
    return version;
  }

  /** The 2x render under a frame pin, so the thread gets its crop; or a check that the block is there. */
  async function anchoredOn(versionId: string, body: z.infer<typeof CreateThread>) {
    if (body.anchor?.type === "frame") {
      const [frame] = await db
        .select({ renders: frames.renders })
        .from(frames)
        .where(
          and(
            eq(frames.versionId, versionId),
            eq(frames.pageKey, body.pageKey),
            eq(frames.frameKey, body.anchor.frameKey),
          ),
        )
        .limit(1);
      if (!frame) throw new ApiError("invalid", "That frame isn't in this version.");
      return frame.renders["2x"];
    }
    if (body.anchor?.type === "object") {
      // A pin on a native object names the checkpoint it was made on, and the object must be in it (14).
      if (body.anchor.checkpoint !== body.version)
        throw new ApiError("invalid", "An object pin is made on the version it names.");
      const [board] = await db
        .select({ snapshot: boardVersions.snapshot })
        .from(boardVersions)
        .where(and(eq(boardVersions.versionId, versionId), eq(boardVersions.pageKey, body.pageKey)))
        .limit(1);
      const objectId = body.anchor.object;
      if (!board?.snapshot.objects.some((object) => object.id === objectId))
        throw new ApiError("invalid", "That object isn't in this version.");
      return null;
    }
    if (body.anchor) {
      const [block] = await db
        .select({ id: blocks.id })
        .from(blocks)
        .where(
          and(
            eq(blocks.versionId, versionId),
            eq(blocks.pageKey, body.pageKey),
            eq(blocks.blockKey, body.anchor.blockKey),
          ),
        )
        .limit(1);
      if (!block) throw new ApiError("invalid", "That block isn't in this version.");
    }
    return null;
  }

  async function startThread(asker: Asker, resource: LoadedArtifact, body: z.infer<typeof CreateThread>) {
    const { org, caller } = asker;
    const artifactId = resource.id;
    countComment(caller);
    const version = await liveVersion(artifactId, body.version);
    const render = await anchoredOn(version.id, body);

    const author = authorOf(caller, artifactId, body.agent);
    const threadId = Bun.randomUUIDv7();
    const now = clock.now();
    const row = await db.transaction(async (tx) => {
      await lockArtifact(tx, artifactId, "threads");
      const [counted] = await tx
        .update(artifacts)
        .set({ threadCounter: sql`${artifacts.threadCounter} + 1` })
        .where(eq(artifacts.id, artifactId))
        .returning({ next: artifacts.threadCounter });
      const [thread] = await tx
        .insert(threads)
        .values({
          id: threadId,
          orgId: org.id,
          artifactId,
          n: counted?.next ?? 1,
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
        orgId: org.id,
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
          const key = cropKey(threadId);
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
    await record(asker, artifactId, "commented", { thread: row.n, version: body.version }, author.agent);
    void deps.events.emit(artifactId, "thread", { thread: row.n });
    return (await threadViews([final]))[0] as Thread;
  }

  async function replyTo(
    asker: Asker,
    resource: LoadedArtifact,
    thread: ThreadRow,
    body: z.infer<typeof CreateComment>,
  ) {
    const { caller } = asker;
    countComment(caller);
    const mayFix =
      caller.kind === "cliToken" || (caller.kind === "person" && caller.person.id === resource.publisherId);
    if (body.marksFixed && !mayFix)
      throw new ApiError("forbidden", "Only an agent or the publisher marks a thread fixed.");

    // Leaving "resolved" is for people, with Reopen (03).
    if (body.marksFixed && thread.status === "resolved") {
      throw new ApiError("conflict", "That thread is resolved. A person has to reopen it.");
    }
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
    const [comment] = (await db
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
      .returning()) as [CommentRow];
    if (body.marksFixed) {
      await db
        .update(threads)
        .set({ status: "fixed", fixedVersion: latest })
        .where(eq(threads.id, thread.id));
    } else if (reopens) {
      await db.update(threads).set({ status: "open", fixedVersion: null }).where(eq(threads.id, thread.id));
    }
    await record(
      asker,
      thread.artifactId,
      body.marksFixed ? "fixed" : reopens ? "reopened" : "replied",
      { thread: thread.n, version: latest },
      author.agent,
    );
    void deps.events.emit(thread.artifactId, "comment", { thread: thread.n });
    void notifyReply(deps, resource, thread, {
      authorName: author.agent ? agentLabel(comment.authorName, author.agent) : comment.authorName,
      body: comment.body,
      actor: author.agent ? null : comment.authorPersonId,
    });
    return commentView(comment);
  }

  async function setResolved(asker: Asker<Person>, thread: ThreadRow, resolved: boolean) {
    const [row] = await db
      .update(threads)
      .set(
        resolved
          ? { status: "resolved", resolvedAt: clock.now(), resolvedBy: asker.caller.person.id }
          : { status: "open", resolvedAt: null, resolvedBy: null, fixedVersion: null },
      )
      .where(eq(threads.id, thread.id))
      .returning();
    await record(asker, thread.artifactId, resolved ? "resolved" : "reopened", { thread: thread.n });
    void deps.events.emit(thread.artifactId, "thread", { thread: thread.n });
    return (await threadViews([row as ThreadRow]))[0] as Thread;
  }

  async function decide(
    asker: Asker<Person>,
    resource: LoadedArtifact,
    body: z.infer<typeof CreateDecision>,
  ) {
    await liveVersion(resource.id, body.version);
    await db.insert(decisions).values({
      id: Bun.randomUUIDv7(),
      orgId: asker.org.id,
      artifactId: resource.id,
      version: body.version,
      personId: asker.caller.person.id,
      kind: body.kind,
      note: body.note ?? null,
      createdAt: clock.now(),
    });
    await record(asker, resource.id, body.kind, { version: body.version, note: body.note ?? null });
    void deps.events.emit(resource.id, "decision", { version: body.version });
  }

  /** The latest decision and what's still open, for whoever reviews or answers for the work. */
  async function status({ org, caller }: Asker, resource: LoadedArtifact): Promise<ArtifactReviewStatus> {
    const [latest] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.artifactId, resource.id))
      .orderBy(desc(decisions.createdAt))
      .limit(1);
    const rows = await db
      .select()
      .from(threads)
      .where(and(eq(threads.artifactId, resource.id), inArray(threads.status, ["open", "fixed"])))
      .orderBy(asc(threads.n));
    const views = await threadViews(rows);
    return {
      // For whoever answers for the work: anyone else needn't learn who else was let in.
      ...(can(caller, "artifact.share", resource) || caller.kind === "orgToken"
        ? { audience: await audienceOf(deps, org.name, resource, caller) }
        : {}),
      version: resource.row.latestVersion,
      decision: latest?.kind ?? null,
      decisionVersion: latest?.version ?? null,
      note: latest?.note ?? null,
      open: views.filter((thread) => thread.status === "open"),
      fixedAwaiting: views.filter((thread) => thread.status === "fixed"),
    };
  }

  return { threadViews, listThreads, startThread, replyTo, setResolved, decide, status };
}
