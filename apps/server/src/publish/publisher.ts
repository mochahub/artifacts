import {
  agentLabel,
  type BlockRecord,
  type CheckpointKind,
  FILES_MAX,
  type FrameRecord,
  HOUR_MS,
  isBundlePath,
  normalizeRepo,
  type PageRecord,
  type PublishCommit,
  type PublishPrepare,
  type PublishResult,
} from "@artifacts/schema";
import { sanitizeArticle } from "@artifacts/schema/sanitize";
import { articleLinks } from "@artifacts/schema/wiki";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { type ArtifactRow, findArtifact, type ProjectRow, toProject, toResource } from "../auth/access.ts";
import { type Asker, actorOf, agentOf } from "../auth/caller.ts";
import { type CallerFor, can, seesArtifact, seesProject } from "../auth/can.ts";
import { signPayload, verifyPayload } from "../auth/signed.ts";
import type { Tx } from "../db/index.ts";
import { lockArtifact } from "../db/locks.ts";
import { activity, artifacts, blobs, people, projectAccess, projects, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { carryIds } from "../editing/carry.ts";
import { outsideDraft } from "../editing/checkpoint.ts";
import { ApiError } from "../http/errors.ts";
import { requireCan } from "../http/routes.ts";
import { blobKey } from "../layout.ts";
import { audienceOf } from "../library/audience.ts";
import { mapLimit } from "../map-limit.ts";
import { notifyPublished } from "../push/notify.ts";
import { reanchorThreads } from "../review/reanchor.ts";
import { writeContent } from "../versions/content.ts";
import { blockHashes, type Changes, changes, frameHashes, hashesOf, NOTHING } from "../versions/diff.ts";
import { validateWikiSources } from "../wiki/service.ts";
import { IMMUTABLE, knownBlobs, putBlob, verifyBlobs } from "./blobs.ts";

const UPLOAD_INFO = "upload";
const UPLOAD_HOURS = 2;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
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
  /** Set when a payload blob carries the commit, so it can only commit that payload (MCP). */
  payload: string | null;
  exp: number;
};

/** The whole answer for someone outside a restricted project: no more than any taken name tells them. */
const nameTaken = () => new ApiError("conflict", "That project name is taken.");

/** Frame keys are per page in the database; the change summary names them as authors wrote them. */
const withoutPage = (change: Changes): Changes => ({
  added: change.added.map((key) => key.slice(key.indexOf("/") + 1)),
  removed: change.removed.map((key) => key.slice(key.indexOf("/") + 1)),
  changed: change.changed.map((key) => key.slice(key.indexOf("/") + 1)),
});

export type Publisher = ReturnType<typeof createPublisher>;

/** What a new version holds, from a publish, an article or a checkpoint (13, "Checkpoints"). */
export type VersionInput = {
  artifactId: string;
  orgId: string;
  projectId: string;
  title: string;
  files: Record<string, { hash: string; size: number; type: string }>;
  backendHash: string | null;
  message: string | null;
  name: string | null;
  notes: Record<string, string>;
  summary: string | null;
  tags: string[] | null;
  wiki: (typeof versions.$inferInsert)["wiki"];
  links: string[];
  pages: PageRecord[];
  frames: FrameRecord[];
  blocks: (BlockRecord & { authors?: { s: number; e: number; a: string; t: string }[] | null })[];
  checkpoint: CheckpointKind | null;
  docSeq: number | null;
  now: Date;
};

/**
 * The part of a commit after the permission check (13): the version row, its content, re-anchoring, the
 * artifact's latest version and the log. Publishes, articles and checkpoints all come through here, inside
 * the artifact's lock. `current` is the artifacts row as read under that lock.
 */
export async function commitVersion(
  tx: Tx,
  current: ArtifactRow | undefined,
  input: VersionInput,
  by: { personId: string; agent: string | null },
) {
  const n = (current?.latestVersion ?? 0) + 1;
  const [previous] = current
    ? await tx
        .select()
        .from(versions)
        .where(and(eq(versions.artifactId, current.id), eq(versions.n, current.latestVersion)))
        .limit(1)
    : [];
  const versionId = Bun.randomUUIDv7();
  await tx.insert(versions).values({
    id: versionId,
    orgId: input.orgId,
    artifactId: input.artifactId,
    n,
    files: input.files,
    backendHash: input.backendHash,
    message: input.message,
    name: input.name,
    notes: input.notes,
    summary: input.summary,
    tags: input.tags,
    wiki: input.wiki,
    links: input.links,
    publishedBy: by.personId,
    agent: by.agent,
    checkpoint: input.checkpoint,
    docSeq: input.docSeq,
    publishedAt: input.now,
  });
  await writeContent(tx, input.orgId, versionId, input.pages, input.frames, input.blocks);
  const reanchored = await reanchorThreads(tx, input.artifactId, input.pages, input.frames, input.blocks);
  const before = previous ? await hashesOf(tx, previous.id) : NOTHING;
  const after = { frames: frameHashes(input.frames), blocks: blockHashes(input.blocks) };
  await tx
    .update(artifacts)
    .set({
      latestVersion: n,
      title: input.title,
      hasBackend: Boolean(input.backendHash),
      updatedAt: input.now,
    })
    .where(eq(artifacts.id, input.artifactId));
  await tx.update(projects).set({ updatedAt: input.now }).where(eq(projects.id, input.projectId));
  await tx.insert(activity).values({
    id: Bun.randomUUIDv7(),
    orgId: input.orgId,
    artifactId: input.artifactId,
    projectId: input.projectId,
    actorPersonId: by.personId,
    agent: by.agent,
    kind: input.checkpoint ? "checkpointed" : "published",
    payload: input.checkpoint
      ? { version: n, kind: input.checkpoint, message: input.message }
      : { version: n, message: input.message },
    createdAt: input.now,
  });
  return {
    version: n,
    frames: withoutPage(changes(before.frames, after.frames)),
    blocks: changes(before.blocks, after.blocks),
    ...reanchored,
  };
}

/** Publishing, for the API and the hosted MCP alike. */
export function createPublisher(deps: Deps) {
  const { db, env, clock, bucket } = deps;

  /** Who may publish to this project/slug, and the row if it exists. Prepare and commit both run this. */
  async function target(
    { org, caller }: Asker,
    projectSlug: string,
    slug: string,
  ): Promise<{
    row: ArtifactRow | null;
    project: ProjectRow | undefined;
    caller: CallerFor<"artifact.publish">;
  }> {
    const orgId = org.id;
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

    const place = project ? await toProject(deps, project) : null;
    const resource = row ? await toResource(deps, row) : null;
    // Before anything about the slug, or the two answers would say which artifacts are in there.
    const allowed = place && (seesProject(caller, place) || can(caller, "project.publish", place));
    if (place?.restricted && !allowed && !(resource && seesArtifact(caller, resource))) throw nameTaken();
    if (!row || !resource) {
      requireCan(caller, "project.create", { type: "org" });
      if (place && !can(caller, "project.publish", place)) {
        throw new ApiError(
          "forbidden",
          caller.kind === "orgToken"
            ? "This token can't publish to that project."
            : "You can't add to that project.",
        );
      }
      return { row: null, project, caller };
    }
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
    requireCan(caller, "artifact.publish", resource);
    return { row, project, caller };
  }

  async function prepare(asker: Asker, body: z.infer<typeof PublishPrepare>, payload: string | null = null) {
    const { org } = asker;
    const { row: existing, caller } = await target(asker, body.project, body.slug);

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
        contentType: type,
        contentLength: size,
        cacheControl: IMMUTABLE,
      })),
    }));

    const ticket: UploadTicket = {
      artifactId: existing?.id ?? Bun.randomUUIDv7(),
      isNew: !existing,
      project: body.project,
      projectName: body.projectName ?? body.project,
      // Whatever a client sends: a remote can hold a password, and lookups need one form for one repo.
      repo: normalizeRepo(body.repo),
      slug: body.slug,
      title: body.title,
      // An org token has no person to be private to, so what it makes stays reachable by it.
      visibility: caller.kind === "orgToken" ? "org" : (body.visibility ?? org.settings.defaultVisibility),
      uploaded: { files: missing.length, bytes: missing.reduce((sum, [, file]) => sum + file.size, 0) },
      reused: known.size,
      payload,
      exp: clock.now().getTime() + UPLOAD_HOURS * HOUR_MS,
    };
    return {
      uploadId: signPayload(ticket, env.sessionSecret, UPLOAD_INFO),
      artifactId: ticket.artifactId,
      missing: signed,
    };
  }

  async function commit(asker: Asker, body: z.infer<typeof PublishCommit>, payload: string | null = null) {
    const { org } = asker;
    const ticket = verifyPayload<UploadTicket>(body.uploadId, env.sessionSecret, UPLOAD_INFO);
    if (!ticket || ticket.exp <= clock.now().getTime()) {
      throw new ApiError("invalid", "This upload expired. Publish again.");
    }
    // A ticket made for one payload commits only that one, and a ticket for the API none.
    if ((ticket.payload ?? null) !== payload) {
      throw new ApiError("invalid", "This upload was made for another payload.");
    }
    const {
      row: existing,
      project: targetProject,
      caller,
    } = await target(asker, ticket.project, ticket.slug);
    if (existing && existing.id !== ticket.artifactId) throw new ApiError("conflict", "That slug is taken.");
    // Library reads use the pool; finish them before holding a transaction's connection.
    if (targetProject?.kind === "wiki" && body.wiki)
      await validateWikiSources(deps, org.id, caller, targetProject.id, ticket.slug, body.wiki);

    // Every hash the version will use must be proved before anything is written.
    const wanted = new Map<string, number | null>();
    for (const [path, file] of Object.entries(body.files)) {
      // `artifacts pull` writes these paths to someone's disk.
      if (!isBundlePath(path))
        throw new ApiError("invalid", `${path.slice(0, 200)} isn't a path in a bundle.`);
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
    // Prepare declared at most this many files, renders included, and each hash is looked up and maybe
    // downloaded here, so a manifest can't name more.
    if (wanted.size > FILES_MAX) {
      throw new ApiError("too_large", "That's too many files.", { limit: FILES_MAX });
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
    const linked = new Set<string>();
    const carried = new Map<string, z.infer<typeof PublishCommit>["blocks"]>();
    const safePages: PageRecord[] = await mapLimit(body.pages, 4, async (page) => {
      const hash = page.meta.htmlHash;
      if (page.kind !== "article") return page;
      if (!hash || !wanted.has(hash)) throw new ApiError("invalid", `Article ${page.key} has no HTML.`);
      const object = await bucket.get(blobKey(hash));
      if (!object) throw new ApiError("invalid", `Article ${page.key} has no HTML.`);
      // Only checkpoints set lasting ids (13); a client's are ignored.
      const { blockIds: _ignored, ...meta } = page.meta;
      const clean = sanitizeArticle(new TextDecoder().decode(object.body));
      // From the HTML just cleaned, never from the client: backlinks are only as true as this (SPEC 16).
      for (const link of articleLinks(clean)) linked.add(link);
      // A page that was edited in the browser keeps its lasting ids where the blocks still match (13).
      const kept = existing
        ? await carryIds(deps, {
            artifactId: existing.id,
            latestVersion: existing.latestVersion,
            pageKey: page.key,
            project: ticket.project,
            files: body.files,
            html: clean,
            blocks: body.blocks.filter((block) => block.pageKey === page.key),
          })
        : null;
      if (kept) carried.set(page.key, kept.blocks);
      const htmlHash = await putBlob(
        deps,
        org.id,
        new TextEncoder().encode(kept?.html ?? clean),
        "text/html; charset=utf-8",
      );
      return { ...page, meta: { ...meta, htmlHash, ...(kept ? { blockIds: kept.blockIds } : {}) } };
    });

    const taken = new Map<string, number>();
    const blockRows = body.blocks.map((block) => {
      const list = carried.get(block.pageKey);
      if (!list) return block;
      const at = taken.get(block.pageKey) ?? 0;
      taken.set(block.pageKey, at + 1);
      return list[at] ?? block;
    });
    const publisher = actorOf(caller);
    const agent = agentOf(caller, body.agent);
    const now = clock.now();
    let flushDraft = () => {};
    const result = await db.transaction(async (tx) => {
      await lockArtifact(tx, ticket.artifactId, "content");

      let [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, org.id), eq(projects.slug, ticket.project)))
        .limit(1);
      let made = false;
      if (!project) {
        const byToken = caller.kind === "orgToken";
        [project] = await tx
          .insert(projects)
          .values({
            id: Bun.randomUUIDv7(),
            orgId: org.id,
            slug: ticket.project,
            name: ticket.projectName,
            repo: ticket.repo,
            restricted: org.settings.defaultProjectAccess === "restricted",
            createdBy: byToken ? null : publisher,
            createdByToken: byToken ? caller.tokenId : null,
          })
          .onConflictDoNothing({ target: [projects.orgId, projects.slug] })
          .returning();
        // Admins manage what a token made: no person created it (04).
        if (project && !byToken) {
          await tx.insert(projectAccess).values({
            id: Bun.randomUUIDv7(),
            orgId: org.id,
            projectId: project.id,
            personId: publisher,
            permission: "manage",
            grantedBy: publisher,
            createdAt: now,
          });
        }
        made = project !== undefined;
        if (!project) {
          // Someone else's publish made it first.
          [project] = await tx
            .select()
            .from(projects)
            .where(and(eq(projects.orgId, org.id), eq(projects.slug, ticket.project)))
            .limit(1);
        }
      }
      // Under the transaction: it may have appeared, or been restricted, since target() looked.
      if (
        project &&
        !made &&
        ticket.isNew &&
        !can(caller, "project.publish", await toProject(deps, project))
      ) {
        throw nameTaken();
      }
      if (!project) throw new Error("no project row");
      // Projects made before the CLI sent a remote learn it from their next publish.
      if (!project.repo && ticket.repo) {
        await tx.update(projects).set({ repo: ticket.repo }).where(eq(projects.id, project.id));
      }

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

      // GC removes a blob's row before its object, so a hash it took meanwhile shows up here.
      const hashes = [...wanted.keys(), ...safePages.flatMap((page) => page.meta.htmlHash ?? [])];
      const present = await tx
        .select({ hash: blobs.hash })
        .from(blobs)
        .where(and(eq(blobs.orgId, org.id), inArray(blobs.hash, hashes)));
      if (new Set(present.map((row) => row.hash)).size < new Set(hashes).size) {
        throw new ApiError("conflict", "A file was cleaned up during this publish. Publish again.");
      }

      // A page someone is editing isn't replaced; a dirty draft is saved first, then retired (13).
      const draft = current
        ? await outsideDraft(
            deps,
            tx,
            { row: current, project },
            { discard: body.discardDraft, by: publisher },
          )
        : null;
      const [latest] = draft?.saved
        ? await tx.select().from(artifacts).where(eq(artifacts.id, ticket.artifactId)).limit(1)
        : [current];

      const result = await commitVersion(
        tx,
        latest,
        {
          artifactId: ticket.artifactId,
          orgId: org.id,
          projectId: project.id,
          title: ticket.title,
          files: body.files,
          backendHash: body.backendHash ?? null,
          message: body.message ?? null,
          name: body.name ?? null,
          notes: body.notes,
          summary: body.summary ?? null,
          tags: body.tags ?? null,
          wiki: body.wiki ?? null,
          links: [...linked].filter((link) => link !== `${ticket.project}/${ticket.slug}`),
          pages: safePages,
          frames: body.frames,
          blocks: blockRows,
          checkpoint: null,
          docSeq: null,
          now,
        },
        { personId: publisher, agent },
      );
      await draft?.retire(result.version);
      if (draft) flushDraft = draft.flush;
      return result;
    });

    flushDraft();
    const published = await findArtifact(deps, org.id, ticket.artifactId);
    void deps.events.emit(ticket.artifactId, "version", { version: result.version });
    if (published) {
      void notifyPublished(deps, published, {
        version: result.version,
        // Only a named agent: someone running the CLI at their own terminal knows what they published.
        agent:
          body.agent && "person" in caller
            ? agentLabel(caller.person.name, body.agent)
            : (body.agent ?? null),
      });
    }
    const response: PublishResult = {
      version: result.version,
      url: `${env.publicUrl}/${ticket.project}/${ticket.slug}`,
      changes: { frames: result.frames, blocks: result.blocks },
      threadsOnChanged: result.threadsOnChanged,
      orphaned: result.orphaned,
      uploaded: ticket.uploaded,
      reused: ticket.reused,
      ...(published ? { audience: await audienceOf(deps, org.name, published, caller) } : {}),
    };
    return response;
  }

  return { prepare, commit, target };
}
