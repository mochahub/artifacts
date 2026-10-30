import {
  type Anchor,
  type BlockRecord,
  type FrameRecord,
  type PageRecord,
  PublishCommit,
  PublishPrepare,
  type PublishResult,
} from "@artifacts/schema";
import { sanitizeArticle } from "@artifacts/schema/sanitize";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { type ArtifactRow, toResource } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import { type ApiContext, parseBody, type Routes, requireCan } from "../api/routes.ts";
import type { Caller } from "../auth/caller.ts";
import { seesArtifact } from "../auth/can.ts";
import { signPayload, verifyPayload } from "../auth/signed.ts";
import {
  activity,
  artifacts,
  blobs,
  blocks,
  frames,
  pages,
  people,
  projects,
  threads,
  versions,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { notifyPublished } from "../push/notify.ts";
import { reanchor } from "../review/reanchor.ts";
import { blobKey, IMMUTABLE, knownBlobs, mapLimit, putBlob, storedType, verifyBlobs } from "./blobs.ts";

const UPLOAD_INFO = "upload";
const UPLOAD_HOURS = 2;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 20_000;
/** `type/subtype`, then optional parameters, in printable ASCII only: it becomes a response header (03). */
const MEDIA_TYPE = /^[A-Za-z0-9][\w.+-]*\/[\w.+-]+(;[\x20-\x7e]*)?$/;
const checkType = (path: string, type: string) => {
  if (type.length > 200 || !MEDIA_TYPE.test(type)) {
    throw new ApiError("invalid", `${path} has a content type that isn't valid.`);
  }
};

/** Everything commit needs from prepare, signed, so a half-finished publish leaves nothing in Postgres. */
type UploadTicket = {
  artifactId: string;
  isNew: boolean;
  project: string;
  projectName: string;
  repo: string | null;
  slug: string;
  title: string;
  visibility: "me" | "org";
  uploaded: { files: number; bytes: number };
  reused: number;
  exp: number;
};

export const publisherOf = (caller: Caller): string => {
  if (caller.kind === "person" || caller.kind === "cliToken") return caller.person.id;
  if (caller.kind === "orgToken") return caller.createdBy;
  throw new ApiError("forbidden", "You can't publish.");
};

const diff = (before: Map<string, string>, after: Map<string, string>) => ({
  added: [...after.keys()].filter((key) => !before.has(key)),
  removed: [...before.keys()].filter((key) => !after.has(key)),
  changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)),
});

/** Frame keys are per page in the database; the change summary names them as authors wrote them. */
const frameKeys = (change: ReturnType<typeof diff>) => ({
  added: change.added.map((key) => key.slice(key.indexOf("/") + 1)),
  removed: change.removed.map((key) => key.slice(key.indexOf("/") + 1)),
  changed: change.changed.map((key) => key.slice(key.indexOf("/") + 1)),
});

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
}

export function publishRoutes(routes: Routes, deps: Deps) {
  const { db, env, clock, bucket } = deps;

  /** Who may publish to this project/slug, and the row if it exists. Prepare and commit both run this. */
  async function target(c: ApiContext, projectSlug: string, slug: string): Promise<ArtifactRow | null> {
    const orgId = c.get("org").id;
    const caller = c.get("caller");
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, projectSlug)))
      .limit(1);
    const [row] = project
      ? await db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.projectId, project.id), eq(artifacts.slug, slug)))
          .limit(1)
      : [];

    if (!row) {
      requireCan(c, "project.create", { type: "org" });
      if (
        project &&
        caller.kind === "orgToken" &&
        caller.projectIds &&
        !caller.projectIds.includes(project.id)
      ) {
        throw new ApiError("forbidden", "This token can't publish to that project.");
      }
      return null;
    }
    const resource = await toResource(deps, row);
    if (!seesArtifact(caller, resource)) throw new ApiError("conflict", "That slug is taken.");
    if (row.deletedAt) {
      const [by] = await db
        .select({ name: people.name })
        .from(people)
        .where(eq(people.id, row.deletedBy as string))
        .limit(1);
      throw new ApiError(
        "slug_deleted",
        "That artifact is in Recently deleted. Restore it or pick another slug.",
        { deletedAt: row.deletedAt.toISOString(), deletedBy: by?.name ?? null },
      );
    }
    requireCan(c, "artifact.publish", resource);
    return row;
  }

  routes.post("/api/publish/prepare", { action: "artifact.publish", inHandler: true }, async (c) => {
    if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
    const body = await parseBody(c, PublishPrepare);
    const org = c.get("org");
    const existing = await target(c as ApiContext, body.project, body.slug);

    const declared = new Map<string, { size: number; type: string }>();
    for (const file of body.files) {
      checkType(file.path, file.type);
      if (file.size > MAX_FILE_BYTES) {
        throw new ApiError("too_large", `${file.path} is too big.`, { limit: MAX_FILE_BYTES });
      }
      declared.set(file.sha256, { size: file.size, type: file.type });
    }
    const known = await knownBlobs(deps, org.id, [...declared.keys()]);
    const missing = [...declared.entries()].filter(([hash]) => !known.has(hash));
    const signed = await mapLimit(missing, 32, async ([sha256, { size, type }]) => ({
      sha256,
      ...(await bucket.presignPut(blobKey(sha256), {
        contentType: storedType(type),
        contentLength: size,
        cacheControl: IMMUTABLE,
      })),
    }));

    const caller = c.get("caller");
    const ticket: UploadTicket = {
      artifactId: existing?.id ?? Bun.randomUUIDv7(),
      isNew: !existing,
      project: body.project,
      projectName: body.projectName ?? body.project,
      repo: body.repo ?? null,
      slug: body.slug,
      title: body.title,
      // An org token has no person to be private to, so what it makes stays reachable by it.
      visibility: caller.kind === "orgToken" ? "org" : (body.visibility ?? org.settings.defaultVisibility),
      uploaded: { files: missing.length, bytes: missing.reduce((sum, [, file]) => sum + file.size, 0) },
      reused: known.size,
      exp: clock.now().getTime() + UPLOAD_HOURS * 3600_000,
    };
    return c.json({
      uploadId: signPayload(ticket, env.sessionSecret, UPLOAD_INFO),
      artifactId: ticket.artifactId,
      missing: signed,
    });
  });

  routes.post("/api/publish/commit", { action: "artifact.publish", inHandler: true }, async (c) => {
    if (c.get("caller").kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
    const body = await parseBody(c, PublishCommit);
    const org = c.get("org");
    const ticket = verifyPayload<UploadTicket>(body.uploadId, env.sessionSecret, UPLOAD_INFO);
    if (!ticket || ticket.exp <= clock.now().getTime()) {
      throw new ApiError("invalid", "This upload expired. Publish again.");
    }
    const caller = c.get("caller");
    const existing = await target(c as ApiContext, ticket.project, ticket.slug);
    if (existing && existing.id !== ticket.artifactId) throw new ApiError("conflict", "That slug is taken.");

    // Every hash the version will use must be proved before anything is written.
    const wanted = new Map<string, number | null>();
    // Prepare takes at most this many (the schema), and every one is looked up and maybe downloaded here.
    if (Object.keys(body.files).length > MAX_FILES) {
      throw new ApiError("too_large", "That's too many files.", { limit: MAX_FILES });
    }
    for (const [path, file] of Object.entries(body.files)) {
      checkType(path, file.type);
      wanted.set(file.hash, file.size);
    }
    const paths = new Set(Object.keys(body.files));
    for (const frame of body.frames) {
      for (const hash of Object.values(frame.renders)) if (!wanted.has(hash)) wanted.set(hash, null);
      if (frame.livePath && !paths.has(frame.livePath)) {
        throw new ApiError("invalid", `Live page ${frame.livePath} isn't in the bundle.`);
      }
    }
    if (body.backendHash && !wanted.has(body.backendHash)) {
      throw new ApiError("invalid", "The backend module isn't in the bundle.");
    }
    await verifyBlobs(deps, org.id, wanted);
    // The sandbox fetches this module on every request, so a huge one must never get in (08).
    if (body.backendHash) {
      const size = (await knownBlobs(deps, org.id, [body.backendHash])).get(body.backendHash) ?? 0;
      if (size > org.settings.limits.backendCodeBytes) {
        throw new ApiError("too_large", "The backend is too big.", {
          limit: org.settings.limits.backendCodeBytes,
        });
      }
    }

    // The CLI's article HTML can't be trusted: it goes into the viewer's own page (05).
    const safePages: PageRecord[] = await mapLimit(body.pages, 4, async (page) => {
      const hash = page.meta.htmlHash;
      if (page.kind !== "article") return page;
      if (!hash || !wanted.has(hash)) throw new ApiError("invalid", `Article ${page.key} has no HTML.`);
      const object = await bucket.get(blobKey(hash));
      if (!object) throw new ApiError("invalid", `Article ${page.key} has no HTML.`);
      const clean = sanitizeArticle(new TextDecoder().decode(object.body));
      const htmlHash = await putBlob(deps, org.id, new TextEncoder().encode(clean));
      return { ...page, meta: { ...page.meta, htmlHash } };
    });

    const publisher = publisherOf(caller);
    const now = clock.now();
    const result = await db.transaction(async (tx) => {
      // One commit at a time per artifact (03).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ticket.artifactId}, 0))`);

      let [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, org.id), eq(projects.slug, ticket.project)))
        .limit(1);
      if (!project) {
        [project] = await tx
          .insert(projects)
          .values({
            id: Bun.randomUUIDv7(),
            orgId: org.id,
            slug: ticket.project,
            name: ticket.projectName,
            repo: ticket.repo,
          })
          .onConflictDoUpdate({ target: [projects.orgId, projects.slug], set: { updatedAt: now } })
          .returning();
      }
      if (!project) throw new Error("no project row");

      const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, ticket.artifactId)).limit(1);
      if (ticket.isNew) {
        if (current) throw new ApiError("conflict", "This upload was already used.");
        const created = await tx
          .insert(artifacts)
          .values({
            id: ticket.artifactId,
            orgId: org.id,
            projectId: project.id,
            slug: ticket.slug,
            title: ticket.title,
            visibility: ticket.visibility,
            publisherId: publisher,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: artifacts.id });
        if (created.length === 0) throw new ApiError("conflict", "That slug was just taken. Publish again.");
      }
      // Checked again under the lock: it may have been archived or deleted during the uploads above.
      if (current?.archivedAt)
        throw new ApiError("read_only", "This artifact is archived, so it's read-only.");
      if (current?.deletedAt) throw new ApiError("conflict", "That artifact was just deleted.");

      const n = (current?.latestVersion ?? 0) + 1;
      const [previous] = current
        ? await tx
            .select()
            .from(versions)
            .where(and(eq(versions.artifactId, current.id), eq(versions.n, current.latestVersion)))
            .limit(1)
        : [];
      // GC removes a blob's row before its object, so a hash it took meanwhile shows up here.
      const hashes = [...wanted.keys(), ...safePages.flatMap((page) => page.meta.htmlHash ?? [])];
      const present = await tx
        .select({ hash: blobs.hash })
        .from(blobs)
        .where(and(eq(blobs.orgId, org.id), inArray(blobs.hash, hashes)));
      if (new Set(present.map((row) => row.hash)).size < new Set(hashes).size) {
        throw new ApiError("conflict", "A file was cleaned up during this publish. Publish again.");
      }

      const versionId = Bun.randomUUIDv7();
      await tx.insert(versions).values({
        id: versionId,
        orgId: org.id,
        artifactId: ticket.artifactId,
        n,
        files: body.files,
        backendHash: body.backendHash ?? null,
        message: body.message ?? null,
        name: body.name ?? null,
        notes: body.notes,
        publishedBy: publisher,
        agent: body.agent ?? null,
        publishedAt: now,
      });
      await writeContent(tx, org.id, versionId, safePages, body.frames, body.blocks);

      const reanchored = await reanchorThreads(tx, ticket.artifactId, safePages, body.frames, body.blocks);

      const before = previous
        ? await hashesOf(tx, previous.id)
        : { frames: new Map<string, string>(), blocks: new Map<string, string>() };
      const after = {
        frames: new Map(body.frames.map((f) => [`${f.pageKey}/${f.frameKey}`, f.contentHash])),
        blocks: new Map(body.blocks.map((b) => [`${b.pageKey}/${b.blockKey}`, b.contentHash])),
      };

      await tx
        .update(artifacts)
        .set({ latestVersion: n, title: ticket.title, hasBackend: Boolean(body.backendHash), updatedAt: now })
        .where(eq(artifacts.id, ticket.artifactId));
      await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, project.id));
      await tx.insert(activity).values({
        id: Bun.randomUUIDv7(),
        orgId: org.id,
        artifactId: ticket.artifactId,
        projectId: project.id,
        actorPersonId: publisher,
        agent: body.agent ?? null,
        kind: "published",
        payload: { version: n, message: body.message ?? null },
        createdAt: now,
      });
      return {
        version: n,
        frames: frameKeys(diff(before.frames, after.frames)),
        blocks: diff(before.blocks, after.blocks),
        ...reanchored,
      };
    });

    void deps.events.emit(ticket.artifactId, "version", { version: result.version });
    void notifyPublished(deps, org.id, ticket.artifactId, {
      project: ticket.project,
      slug: ticket.slug,
      title: ticket.title,
      version: result.version,
      agent: body.agent ?? null,
    }).catch((error) => deps.log.warn("couldn't send pushes", { error: String(error) }));
    const response: PublishResult = {
      version: result.version,
      url: `${env.publicUrl}/${ticket.project}/${ticket.slug}`,
      changes: { frames: result.frames, blocks: result.blocks },
      threadsOnChanged: result.threadsOnChanged,
      orphaned: result.orphaned,
      uploaded: ticket.uploaded,
      reused: ticket.reused,
    };
    return c.json(response);
  });
}

/** 05, "Re-anchoring". Runs inside the commit, and again when a version is restored or removed. */
export async function reanchorThreads(
  tx: Tx,
  artifactId: string,
  pageRows: { key: string }[],
  frameRows: { pageKey: string; frameKey: string; contentHash: string }[],
  blockRows: { pageKey: string; blockKey: string; contentHash: string; text: string }[],
  onlyCreatedOn?: number,
) {
  const open = await tx
    .select()
    .from(threads)
    .where(and(eq(threads.artifactId, artifactId), ne(threads.status, "resolved"), isNotNull(threads.anchor)))
    .orderBy(threads.n);
  const pageKeys = new Set(pageRows.map((page) => page.key));
  const threadsOnChanged: number[] = [];
  const orphaned: number[] = [];
  const cache = new Map<number, Awaited<ReturnType<typeof hashesOf>>>();

  for (const thread of open) {
    if (!pageKeys.has(thread.pageKey)) continue;
    if (onlyCreatedOn !== undefined && thread.createdVersion !== onlyCreatedOn) continue;
    let then = cache.get(thread.createdVersion);
    if (!then) {
      const [version] = await tx
        .select({ id: versions.id })
        .from(versions)
        .where(and(eq(versions.artifactId, artifactId), eq(versions.n, thread.createdVersion)))
        .limit(1);
      then = version ? await hashesOf(tx, version.id) : { frames: new Map(), blocks: new Map() };
      cache.set(thread.createdVersion, then);
    }
    const prefix = `${thread.pageKey}/`;
    const unprefix = (map: Map<string, string>) =>
      new Map(
        [...map]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, hash]) => [key.slice(prefix.length), hash]),
      );
    const result = reanchor(
      thread.anchor as Anchor,
      { frames: unprefix(then.frames), blocks: unprefix(then.blocks) },
      {
        frames: new Map(
          frameRows.filter((f) => f.pageKey === thread.pageKey).map((f) => [f.frameKey, f.contentHash]),
        ),
        blocks: blockRows
          .filter((b) => b.pageKey === thread.pageKey)
          .map((b) => ({ key: b.blockKey, hash: b.contentHash, text: b.text })),
      },
    );
    await tx
      .update(threads)
      .set({ anchor: result.anchor, anchorState: result.state })
      .where(eq(threads.id, thread.id));
    if (result.state === "orphaned") orphaned.push(thread.n);
    if (result.state === "updated" && thread.status === "open") threadsOnChanged.push(thread.n);
  }
  return { threadsOnChanged, orphaned };
}

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];

/** Copies a version's pages, frames and blocks in. Restoring a version uses this too. */
export async function writeContent(
  tx: Tx,
  orgId: string,
  versionId: string,
  pageRows: PageRecord[],
  frameRows: FrameRecord[],
  blockRows: BlockRecord[],
) {
  await insertChunks(pageRows, (chunk) =>
    tx.insert(pages).values(
      chunk.map((page) => ({
        id: Bun.randomUUIDv7(),
        orgId,
        versionId,
        pageKey: page.key,
        kind: page.kind,
        title: page.title,
        group: page.group,
        position: page.position,
        meta: page.meta,
      })),
    ),
  );
  await insertChunks(frameRows, (chunk) =>
    tx.insert(frames).values(chunk.map((frame) => ({ ...frame, id: Bun.randomUUIDv7(), orgId, versionId }))),
  );
  await insertChunks(blockRows, (chunk) =>
    tx.insert(blocks).values(chunk.map((block) => ({ ...block, id: Bun.randomUUIDv7(), orgId, versionId }))),
  );
}

async function hashesOf(tx: Tx, versionId: string) {
  const [frameRows, blockRows] = await Promise.all([
    tx
      .select({ page: frames.pageKey, key: frames.frameKey, hash: frames.contentHash })
      .from(frames)
      .where(eq(frames.versionId, versionId)),
    tx
      .select({ page: blocks.pageKey, key: blocks.blockKey, hash: blocks.contentHash })
      .from(blocks)
      .where(eq(blocks.versionId, versionId)),
  ]);
  return {
    frames: new Map(frameRows.map((row) => [`${row.page}/${row.key}`, row.hash])),
    blocks: new Map(blockRows.map((row) => [`${row.page}/${row.key}`, row.hash])),
  };
}
