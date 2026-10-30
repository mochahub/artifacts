import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import {
  activity,
  artifactAccess,
  artifacts,
  artifactUsage,
  backendLogs,
  blocks,
  comments,
  decisions,
  frames,
  guestLinks,
  guestViews,
  invites,
  pages,
  projects,
  shareLinks,
  threads,
  tombstones,
  versions,
  views,
} from "../db/schema.ts";

type ArtifactRow = typeof artifacts.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

/** Bucket keys under a prefix, deleted a page at a time. */
export async function deletePrefix(deps: Deps, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await deps.bucket.list(prefix, { cursor });
    await Promise.all(page.objects.map((object) => deps.bucket.delete(object.key)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

/** Erases a version's rows. Its blobs go later, in GC, if nothing else uses them. */
async function deleteVersionRows(tx: Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0], ids: string[]) {
  if (ids.length === 0) return;
  await tx.delete(frames).where(inArray(frames.versionId, ids));
  await tx.delete(blocks).where(inArray(blocks.versionId, ids));
  await tx.delete(pages).where(inArray(pages.versionId, ids));
  await tx.delete(versions).where(inArray(versions.id, ids));
}

/** SPEC §5.5: everything goes, except one line saying that it happened. */
export async function purgeArtifact(deps: Deps, artifact: ArtifactRow, actorId: string | null) {
  const { db, clock } = deps;
  const crops = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${artifact.id}, 0))`);
    // Rechecked under the lock: it may have been restored since this purge was decided.
    const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, artifact.id)).limit(1);
    if (!current?.deletedAt) return null;
    const [project] = await tx.select().from(projects).where(eq(projects.id, artifact.projectId)).limit(1);
    const threadRows = await tx
      .select({ id: threads.id, cropKey: threads.cropKey })
      .from(threads)
      .where(eq(threads.artifactId, artifact.id));
    const threadIds = threadRows.map((row) => row.id);
    if (threadIds.length > 0) await tx.delete(comments).where(inArray(comments.threadId, threadIds));
    await tx.delete(threads).where(eq(threads.artifactId, artifact.id));
    await tx.delete(decisions).where(eq(decisions.artifactId, artifact.id));
    await tx.delete(views).where(eq(views.artifactId, artifact.id));
    await tx.delete(guestViews).where(eq(guestViews.artifactId, artifact.id));
    await tx.delete(artifactAccess).where(eq(artifactAccess.artifactId, artifact.id));
    await tx.delete(artifactUsage).where(eq(artifactUsage.artifactId, artifact.id));
    await tx.delete(backendLogs).where(eq(backendLogs.artifactId, artifact.id));
    const links = await tx
      .select({ id: shareLinks.id })
      .from(shareLinks)
      .where(eq(shareLinks.artifactId, artifact.id));
    if (links.length > 0) {
      await tx.delete(guestLinks).where(
        inArray(
          guestLinks.shareLinkId,
          links.map((link) => link.id),
        ),
      );
    }
    await tx.delete(shareLinks).where(eq(shareLinks.artifactId, artifact.id));
    await tx.delete(invites).where(eq(invites.artifactId, artifact.id));
    const versionRows = await tx
      .select({ id: versions.id })
      .from(versions)
      .where(eq(versions.artifactId, artifact.id));
    await deleteVersionRows(
      tx,
      versionRows.map((row) => row.id),
    );
    await tx.delete(activity).where(eq(activity.artifactId, artifact.id));
    await tx.delete(artifacts).where(eq(artifacts.id, artifact.id));

    const now = clock.now();
    await tx.insert(tombstones).values({
      id: Bun.randomUUIDv7(),
      orgId: artifact.orgId,
      kind: "artifact",
      projectSlug: project?.slug ?? "",
      slug: artifact.slug,
      title: artifact.title,
      deletedBy: artifact.deletedBy,
      purgedAt: now,
    });
    await tx.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: artifact.orgId,
      projectId: artifact.projectId,
      actorPersonId: actorId,
      kind: "purged",
      payload: { title: artifact.title, project: project?.slug ?? "", slug: artifact.slug },
      createdAt: now,
    });
    return threadRows.flatMap((row) => (row.cropKey ? [row.cropKey] : []));
  });
  if (crops === null) return false;
  // Past this point the rows are gone. A bucket failure is logged, and the daily sweep finishes it.
  try {
    await Promise.all(crops.map((key) => deps.bucket.delete(key)));
    await deletePrefix(deps, `data/${artifact.id}/`);
  } catch (error) {
    deps.log.warn("purge left objects for the sweep", { artifact: artifact.id, error: String(error) });
  }
  return true;
}

export async function purgeVersion(
  deps: Deps,
  artifact: ArtifactRow,
  version: VersionRow,
  actorId: string | null,
) {
  const { db, clock } = deps;
  const crops = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${artifact.id}, 0))`);
    const [current] = await tx.select().from(versions).where(eq(versions.id, version.id)).limit(1);
    if (!current?.deletedAt) return null;

    // A version removed because it showed a secret: its crops and quoted words show it too (SPEC §5.5).
    const moved = await tx
      .select()
      .from(threads)
      .where(and(eq(threads.artifactId, artifact.id), eq(threads.movedFromVersion, version.n)));
    for (const thread of moved) {
      const anchor = thread.anchor as { type: string; blockKey?: string } | null;
      await tx
        .update(threads)
        .set({
          cropKey: null,
          anchor: anchor?.type === "text" ? { type: "block", blockKey: anchor.blockKey } : thread.anchor,
        })
        .where(eq(threads.id, thread.id));
    }

    await deleteVersionRows(tx, [version.id]);
    const [project] = await tx.select().from(projects).where(eq(projects.id, artifact.projectId)).limit(1);
    await tx.insert(tombstones).values({
      id: Bun.randomUUIDv7(),
      orgId: artifact.orgId,
      kind: "version",
      projectSlug: project?.slug ?? "",
      slug: artifact.slug,
      title: artifact.title,
      version: version.n,
      deletedBy: version.deletedBy,
      purgedAt: clock.now(),
    });
    await tx.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: artifact.orgId,
      artifactId: artifact.id,
      projectId: artifact.projectId,
      actorPersonId: actorId,
      kind: "purged",
      payload: { title: artifact.title, version: version.n },
      createdAt: clock.now(),
    });
    return moved.flatMap((thread) => (thread.cropKey ? [thread.cropKey] : []));
  });
  if (crops === null) return false;
  try {
    await Promise.all(crops.map((key) => deps.bucket.delete(key)));
  } catch (error) {
    deps.log.warn("purge left crops for the sweep", { version: version.id, error: String(error) });
  }
  return true;
}

/** Everything past its 30 days (05, "Clean-up"). */
export async function purgeExpired(deps: Deps) {
  const { db, clock } = deps;
  const now = clock.now();
  const expired = await db
    .select()
    .from(artifacts)
    .where(and(isNotNull(artifacts.deletedAt), lt(artifacts.purgeAfter, now)));
  // One failure mustn't stop the rest.
  const each = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      deps.log.error("purge failed", { error: String(error) });
    }
  };
  for (const row of expired) await each(() => purgeArtifact(deps, row, null));
  const versionRows = await db
    .select({ version: versions, artifact: artifacts })
    .from(versions)
    .innerJoin(artifacts, eq(artifacts.id, versions.artifactId))
    .where(and(isNotNull(versions.deletedAt), lt(versions.purgeAfter, now), isNull(artifacts.deletedAt)));
  for (const { version, artifact } of versionRows)
    await each(() => purgeVersion(deps, artifact, version, null));
  return { artifacts: expired.length, versions: versionRows.length };
}
