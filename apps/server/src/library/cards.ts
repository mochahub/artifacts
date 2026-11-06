import {
  type ArtifactCard,
  agentLabel,
  type LibraryCard,
  type LibraryMatch,
  SUMMARY_MAX,
} from "@artifacts/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { type Caller, viewerId } from "../auth/caller.ts";
import {
  blocks,
  comments,
  decisions,
  frames,
  guestViews,
  pages,
  people,
  threads,
  versions,
  views,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import type { Loaded } from "./visible.ts";

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX - 1)}…`;
};

/** Versions from before `summary` stay valid: they show their first text instead (05). */
async function fallbackSummaries(deps: Deps, rows: { id: string; message: string | null }[]) {
  const ids = rows.map((row) => row.id);
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const [blockRows, frameRows] = await Promise.all([
    deps.db
      .selectDistinctOn([blocks.versionId], { versionId: blocks.versionId, text: blocks.text })
      .from(blocks)
      .where(inArray(blocks.versionId, ids))
      .orderBy(blocks.versionId, blocks.id),
    deps.db
      .select({ versionId: frames.versionId, title: frames.title })
      .from(frames)
      .where(inArray(frames.versionId, ids))
      .orderBy(frames.y, frames.x)
      .limit(ids.length * 12),
  ]);
  for (const row of rows) {
    const first = blockRows.find((entry) => entry.versionId === row.id)?.text;
    const titles = frameRows
      .filter((entry) => entry.versionId === row.id && entry.title)
      .map((entry) => entry.title)
      .join(", ");
    result.set(row.id, clip(first || row.message || titles));
  }
  return result;
}

/** Compact cards, in the order given: everything an agent needs to decide whether to open one. */
export async function libraryCards(
  deps: Deps,
  caller: Caller,
  list: Loaded[],
  matches: Map<string, z.infer<typeof LibraryMatch>> = new Map(),
): Promise<LibraryCard[]> {
  if (list.length === 0) return [];
  const ids = list.map(({ row }) => row.id);
  const [cards, versionRows, decisionRows] = await Promise.all([
    buildCards(deps, caller, list),
    deps.db
      .select({
        id: versions.id,
        artifactId: versions.artifactId,
        n: versions.n,
        summary: versions.summary,
        tags: versions.tags,
        message: versions.message,
      })
      .from(versions)
      .where(inArray(versions.artifactId, ids)),
    deps.db
      .select()
      .from(decisions)
      .where(inArray(decisions.artifactId, ids))
      .orderBy(desc(decisions.createdAt)),
  ]);
  const head = new Map(
    list.flatMap(({ row }) => {
      const version = versionRows.find((v) => v.artifactId === row.id && v.n === row.latestVersion);
      return version ? [[row.id, version] as const] : [];
    }),
  );
  const fallback = await fallbackSummaries(
    deps,
    [...head.values()].filter((version) => !version.summary),
  );
  const byId = new Map(cards.map((card) => [card.id, card]));
  return list.flatMap(({ row, projectSlug }) => {
    const card = byId.get(row.id);
    const version = head.get(row.id);
    if (!card || !version) return [];
    const decision = decisionRows.find((entry) => entry.artifactId === row.id);
    return [
      {
        project: projectSlug,
        slug: row.slug,
        title: row.title,
        summary: version.summary ?? fallback.get(version.id) ?? "",
        tags: version.tags ?? [],
        status: card.status.kind,
        outcome: {
          decision: decision?.kind ?? null,
          decisionVersion: decision?.version ?? null,
          openComments: card.counts.open,
          archived: row.archivedAt !== null,
        },
        latestVersion: row.latestVersion,
        updatedAt: row.updatedAt.toISOString(),
        match: matches.get(row.id) ?? null,
      },
    ];
  });
}

/** Status, counts and cover for a set of artifacts, in as few queries as possible (02, "Derived state"). */
export async function buildCards(deps: Deps, caller: Caller, list: Loaded[]): Promise<ArtifactCard[]> {
  if (list.length === 0) return [];
  const { db } = deps;
  const ids = list.map(({ row }) => row.id);
  const who = viewerId(caller);

  const [versionRows, decisionRows, threadRows, viewRows, pageCounts] = await Promise.all([
    db
      .select({
        id: versions.id,
        artifactId: versions.artifactId,
        n: versions.n,
        agent: versions.agent,
        publishedAt: versions.publishedAt,
        publisher: people.name,
      })
      .from(versions)
      .innerJoin(people, eq(people.id, versions.publishedBy))
      .where(and(inArray(versions.artifactId, ids), isNull(versions.deletedAt)))
      .orderBy(desc(versions.n)),
    db.select().from(decisions).where(inArray(decisions.artifactId, ids)).orderBy(desc(decisions.createdAt)),
    db
      .select({
        id: threads.id,
        artifactId: threads.artifactId,
        status: threads.status,
        person: threads.authorPersonId,
        guest: threads.authorGuestId,
      })
      .from(threads)
      .where(inArray(threads.artifactId, ids)),
    who.person
      ? db
          .select({
            artifactId: views.artifactId,
            lastSeenVersion: views.lastSeenVersion,
            lastSeenAt: views.lastSeenAt,
          })
          .from(views)
          .where(and(eq(views.personId, who.person), inArray(views.artifactId, ids)))
      : who.guest
        ? db
            .select({
              artifactId: guestViews.artifactId,
              lastSeenVersion: guestViews.lastSeenVersion,
              lastSeenAt: guestViews.lastSeenAt,
            })
            .from(guestViews)
            .where(and(eq(guestViews.guestId, who.guest), inArray(guestViews.artifactId, ids)))
        : Promise.resolve([]),
    db
      .select({ versionId: pages.versionId, count: sql<number>`count(*)::int` })
      .from(pages)
      .innerJoin(versions, eq(versions.id, pages.versionId))
      .where(inArray(versions.artifactId, ids))
      .groupBy(pages.versionId),
  ]);

  const latestByArtifact = new Map<string, (typeof versionRows)[number][]>();
  for (const version of versionRows) {
    latestByArtifact.set(version.artifactId, [...(latestByArtifact.get(version.artifactId) ?? []), version]);
  }
  const heads = list.flatMap(({ row }) => latestByArtifact.get(row.id)?.slice(0, 2) ?? []);
  const frameRows = heads.length
    ? await db
        .select({
          versionId: frames.versionId,
          key: frames.frameKey,
          hash: frames.contentHash,
          renders: frames.renders,
          y: frames.y,
          x: frames.x,
          w: frames.w,
          h: frames.h,
        })
        .from(frames)
        .where(
          inArray(
            frames.versionId,
            heads.map((version) => version.id),
          ),
        )
    : [];

  const replies = new Map<string, number>();
  const mine = threadRows.filter(
    (t) => (who.person && t.person === who.person) || (who.guest && t.guest === who.guest),
  );
  if (mine.length > 0) {
    const replyRows = await db
      .select({
        threadId: comments.threadId,
        createdAt: comments.createdAt,
        person: comments.authorPersonId,
        agent: comments.agent,
        guest: comments.authorGuestId,
      })
      .from(comments)
      .where(
        inArray(
          comments.threadId,
          mine.map((t) => t.id),
        ),
      );
    for (const thread of mine) {
      const seenAt = viewRows.find((row) => row.artifactId === thread.artifactId)?.lastSeenAt ?? new Date(0);
      const count = replyRows.filter(
        (reply) =>
          reply.threadId === thread.id &&
          reply.createdAt > seenAt &&
          (reply.agent !== null || (who.person ? reply.person !== who.person : reply.guest !== who.guest)),
      ).length;
      replies.set(thread.artifactId, (replies.get(thread.artifactId) ?? 0) + count);
    }
  }

  return list.flatMap(({ row, projectSlug }) => {
    const [latest, previous] = latestByArtifact.get(row.id) ?? [];
    if (!latest) return [];
    const decision = decisionRows.find((entry) => entry.artifactId === row.id);
    const view = viewRows.find((entry) => entry.artifactId === row.id);
    const unseen = latest.n > (view?.lastSeenVersion ?? 0) || (replies.get(row.id) ?? 0) > 0;

    let status: ArtifactCard["status"];
    if (decision?.kind === "approved" && decision.version === latest.n) {
      status = { kind: "approved", version: latest.n };
    } else if (decision?.kind === "changes_requested" && decision.createdAt > latest.publishedAt) {
      status = {
        kind: "with_agent",
        agent: latest.agent ? agentLabel(latest.publisher, latest.agent) : latest.publisher,
      };
    } else if (unseen) status = { kind: "waiting" };
    else status = { kind: "not_reviewed" };

    const own = frameRows.filter((frame) => frame.versionId === latest.id);
    const old = previous ? frameRows.filter((frame) => frame.versionId === previous.id) : [];
    const before = new Map(old.map((frame) => [frame.key, frame.hash]));
    const changedFrames = previous
      ? own.filter((frame) => before.get(frame.key) !== undefined && before.get(frame.key) !== frame.hash)
          .length
      : 0;
    const first = [...own].sort((a, b) => a.y - b.y || a.x - b.x)[0];
    return [
      {
        id: row.id,
        project: projectSlug,
        slug: row.slug,
        title: row.title,
        cover: first
          ? { renderHash: (first.renders as { thumb: string }).thumb, w: first.w, h: first.h }
          : { title: row.title },
        pageCount: pageCounts.find((entry) => entry.versionId === latest.id)?.count ?? 0,
        latestVersion: latest.n,
        status,
        counts: {
          open: threadRows.filter((t) => t.artifactId === row.id && t.status === "open").length,
          repliesToYou: replies.get(row.id) ?? 0,
          changedFrames,
        },
        publishedBy: latest.publisher,
        agent: latest.agent ? agentLabel(latest.publisher, latest.agent) : null,
        publishedAt: latest.publishedAt.toISOString(),
        archivedAt: row.archivedAt?.toISOString() ?? null,
      },
    ];
  });
}
