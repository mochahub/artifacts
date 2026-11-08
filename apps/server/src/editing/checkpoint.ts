import { createHash } from "node:crypto";
import { dirname, join, normalize, sep } from "node:path";
import {
  articleHtmlPath,
  type CheckpointKind,
  type CheckpointResult,
  MANIFEST,
  type PageRecord,
  PRESENCE_TTL_MS,
  type WikiMeta,
} from "@artifacts/schema";
import { buildArticle } from "@artifacts/schema/article";
import { sanitizeArticle } from "@artifacts/schema/sanitize";
import { articleLinks } from "@artifacts/schema/wiki";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { ArtifactRow, ProjectRow } from "../auth/access.ts";
import { checkpointBoardLocked } from "../boards/checkpoint.ts";
import type { Tx } from "../db/index.ts";
import {
  activity,
  artifacts,
  comments,
  editAtoms,
  editDocs,
  editPresence,
  pages,
  people,
  projects,
  suggestions,
  threads,
  tokens,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../layout.ts";
import { putBlob } from "../publish/blobs.ts";
import { commitVersion } from "../publish/publisher.ts";
import { validateWikiSources } from "../wiki/service.ts";
import { authorRuns, docToMarkdown, validate, yToDoc } from "./model.ts";
import { compact, type DocLock, loadDoc, retireDoc, withDocLock } from "./store.ts";

import { captureSnapshot, outsideTransaction } from "./transaction.ts";

export type CheckpointOptions = {
  kind: CheckpointKind;
  /** Who the version is by: the person, the token's person, the run's, or the last editor's. */
  personId: string | null;
  agent: string | null;
  name?: string | null;
  message?: string | null;
};

type Place = { row: ArtifactRow; project: ProjectRow };
type PmNode = { type: string; attrs?: Record<string, unknown>; content?: PmNode[] };
type Fix = { n: number; personId: string | null; agent: string | null; tokenId?: string | null };

const encode = (text: string) => new TextEncoder().encode(text);
const isoMinutes = (t: number) => new Date(t * 60_000).toISOString();

async function blobText(deps: Deps, hash: string | undefined) {
  if (!hash) return null;
  const object = await deps.bucket.get(blobKey(hash));
  return object ? new TextDecoder().decode(object.body) : null;
}

/** The bundle files a chart atom reads, so `buildArticle`'s synchronous `readFile` has them. */
function chartPaths(source: string, page: string) {
  return [...source.matchAll(/::chart\{[^}]*src="?([^"}\s]+)"?/g)].map((match) =>
    normalize(join(dirname(page), match[1] as string))
      .split(sep)
      .join("/"),
  );
}

type VersionRow = typeof versions.$inferSelect;
type DraftMeta = { title?: string; summary?: string; tags?: string[]; sources?: string[] } | null;

/**
 * Title, summary, tags and wiki metadata for the next checkpoint, article or board: the draft's meta over
 * the base version. Sources set since the last version are checked again, as at publish, as its author.
 */
export async function resolveVersionMeta(
  deps: Deps,
  tx: Tx,
  current: ArtifactRow,
  base: VersionRow,
  manifest: { title?: string },
  meta: DraftMeta,
  options: CheckpointOptions,
  loaded: { lastActorPersonId: string | null },
  fail: (message: string) => never,
) {
  const title = meta?.title ?? manifest.title ?? current.title;
  const summary = meta?.summary ?? base.summary;
  const tags = meta?.tags ?? base.tags;
  const wiki = base.wiki
    ? { ...base.wiki, ...(meta?.sources ? { sources: meta.sources } : {}) }
    : meta?.sources
      ? { role: "page" as const, sources: meta.sources, origin: null, untrusted: false }
      : null;
  if (meta?.sources?.length && wiki) {
    const personId = options.personId ?? loaded.lastActorPersonId ?? current.publisherId;
    const [person] = await tx
      .select({ id: people.id, name: people.name, email: people.email, role: people.role })
      .from(people)
      .where(eq(people.id, personId))
      .limit(1);
    if (!person) return fail("The page's author is gone.");
    try {
      await validateWikiSources(
        deps,
        current.orgId,
        { kind: "person", person, sessionId: "checkpoint", recentAuth: false },
        current.projectId,
        current.slug,
        wiki as WikiMeta,
      );
    } catch (error) {
      if (error instanceof ApiError) return fail(error.message);
      throw error;
    }
  }
  return { title, summary, tags, wiki };
}

/**
 * Makes a checkpoint inside a lock someone already holds (13, "Checkpoints"), and answers whether it made
 * one. Every trigger was authorized when it was asked for, so this checks no caller. A problem with the
 * draft fails it, keeps the draft, and tells the editors.
 */
export async function checkpointLocked(
  deps: Deps,
  lock: DocLock,
  place: Place,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  // One dispatch on the draft's kind, inside this lock: saved, quiet, handoff, run and sweep alike (14).
  if (lock.row?.kind === "board") return checkpointBoardLocked(deps, lock, place, options);
  const { tx, row } = lock;
  const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, place.row.id)).limit(1);
  if (!current) throw new ApiError("not_found", "No such artifact.");
  const unchanged = { version: current.latestVersion, created: false, kind: null };
  if (!row || row.snapshot.length === 0) return unchanged;
  const meta = row.meta as (typeof row.meta & { fixes?: Fix[] }) | null;
  const metaFields = meta ? Object.keys(meta).filter((key) => key !== "fixes" && key !== "sweep") : [];
  if (row.seq === row.checkpointSeq && metaFields.length === 0 && !meta?.fixes?.length) return unchanged;
  if (current.archivedAt) throw new ApiError("read_only", "This artifact is archived, so it's read-only.");

  const fail = (message: string): never => {
    deps.log.warn("checkpoint failed", { artifact: place.row.id, message });
    // Now, not after the commit: the throw rolls the transaction back, and this carries no state.
    deps.docs?.notify(place.row.id, "c", { t: "error", code: "checkpoint_failed", message });
    throw new ApiError("invalid", message);
  };

  const { ydoc, row: loaded } = await loadDoc(deps, place.row.id, lock);
  const valid = await outsideTransaction(`checkpoint-valid:${place.row.id}`, () => validate(ydoc));
  if (!valid.ok) fail(`The draft isn't valid: ${valid.reason}`);
  const doc = await outsideTransaction(`checkpoint-doc:${place.row.id}`, () => yToDoc(ydoc) as PmNode);
  const atomRows = await tx
    .select({ hash: editAtoms.hash, kind: editAtoms.kind, source: editAtoms.source, svg: editAtoms.svg })
    .from(editAtoms)
    .where(eq(editAtoms.artifactId, place.row.id));
  const atoms = new Map(atomRows.map((atom) => [atom.hash, atom]));
  const { markdown, blockIds } = await outsideTransaction(`checkpoint-markdown:${place.row.id}`, () =>
    docToMarkdown(doc as never, (hash: string) => atoms.get(hash)?.source ?? ""),
  );

  const [base] = await tx
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, current.id), eq(versions.n, current.latestVersion)))
    .limit(1);
  const [basePage] = base
    ? await tx
        .select()
        .from(pages)
        .where(and(eq(pages.versionId, base.id), eq(pages.pageKey, row.pageKey)))
        .limit(1)
    : [];
  if (!base || !basePage) return fail("The page's version is missing.");
  captureSnapshot(`checkpoint-base:${current.id}`, {
    base,
    basePage,
    atoms: [...atomRows].sort((a, b) => a.hash.localeCompare(b.hash)),
  });
  const manifest = JSON.parse((await blobText(deps, base.files[MANIFEST]?.hash)) ?? "{}") as {
    title?: string;
    summary?: string;
    tags?: string[];
    wiki?: { sources?: string[] } & Record<string, unknown>;
    pages?: { id: string; src?: string; title?: string }[];
  };
  const src = manifest.pages?.find((entry) => entry.id === row.pageKey)?.src;
  if (!src) return fail("The page's source is missing.");

  const charts = new Map<string, string>();
  for (const atom of atomRows) {
    if (atom.kind !== "chart") continue;
    for (const path of chartPaths(atom.source, src)) {
      const text = await blobText(deps, base.files[path]?.hash);
      if (text !== null) charts.set(path, text);
    }
  }
  const built = await outsideTransaction(`checkpoint-render:${place.row.id}`, () =>
    buildArticle({
      source: markdown,
      path: src,
      project: place.project.slug,
      blockIds,
      mermaid: new Map(atomRows.flatMap((atom) => (atom.svg ? [[atom.source, atom.svg] as const] : []))),
      readFile: (path) => charts.get(path) ?? "",
      blobHash: (path) => base.files[path]?.hash,
      frameHash: () => undefined,
    }),
  );
  const problem = built.problems.find((entry) => entry.severity === "error");
  if (problem) fail(problem.message);

  const { title, summary, tags, wiki } = await resolveVersionMeta(
    deps,
    tx,
    current,
    base,
    manifest,
    meta,
    options,
    loaded,
    fail,
  );
  const clean = await outsideTransaction(`checkpoint-sanitize:${place.row.id}`, () =>
    sanitizeArticle(built.html),
  );
  const nextManifest = {
    ...manifest,
    title,
    ...(summary ? { summary } : {}),
    ...(tags ? { tags } : {}),
    ...(wiki ? { wiki } : {}),
    pages: manifest.pages?.map((entry) => (entry.id === row.pageKey ? { ...entry, title } : entry)),
  };
  const files = { ...base.files };
  const stored: [string, string, string][] = [
    [src, markdown, "text/markdown"],
    [articleHtmlPath(row.pageKey), clean, "text/html; charset=utf-8"],
    [MANIFEST, JSON.stringify(nextManifest, null, 2), "application/json"],
  ];
  let htmlHash = "";
  for (const [path, body, type] of stored) {
    const bytes = encode(body);
    const hash = await putBlob(deps, place.row.orgId, bytes, type);
    const staged = await deps.bucket.get(blobKey(hash));
    await outsideTransaction(`checkpoint-verify:${hash}`, () => {
      if (
        !staged ||
        staged.body.length !== bytes.length ||
        createHash("sha256").update(staged.body).digest("hex") !== hash
      )
        throw new ApiError("invalid", "Staged checkpoint failed verification.");
    });
    files[path] = { hash, size: bytes.length, type };
    if (path === articleHtmlPath(row.pageKey)) htmlHash = hash;
  }

  // Who wrote each passage, as offsets into the block's text, from the draft's author marks.
  const byId = new Map((doc.content ?? []).map((node) => [String(node.attrs?.id ?? ""), node]));
  const blockRows = built.blocks.map((block) => {
    const node = byId.get(block.blockKey);
    const runs = node ? authorRuns(node as never) : [];
    return {
      pageKey: row.pageKey,
      ...block,
      authors: runs.length
        ? runs.map((run: { s: number; e: number; a: string; t: number }) => ({
            ...run,
            t: isoMinutes(run.t),
          }))
        : null,
    };
  });
  const page: PageRecord = {
    key: row.pageKey,
    kind: "article",
    title,
    group: basePage.group,
    position: basePage.position,
    meta: {
      ...basePage.meta,
      htmlHash,
      outline: built.outline,
      readingMinutes: built.readingMinutes,
      blockIds,
    },
  };

  const personId = options.personId ?? loaded.lastActorPersonId ?? current.publisherId;
  const now = deps.clock.now();
  const result = await commitVersion(
    tx,
    current,
    {
      artifactId: current.id,
      orgId: current.orgId,
      projectId: current.projectId,
      title,
      files,
      backendHash: null,
      message: options.message ?? null,
      name: options.name ?? null,
      notes: {},
      summary,
      tags,
      wiki: wiki as never,
      links: articleLinks(clean).filter((link) => link !== `${place.project.slug}/${current.slug}`),
      pages: [page],
      frames: [],
      blocks: blockRows,
      checkpoint: options.kind,
      docSeq: loaded.seq,
      now,
    },
    { personId, agent: options.agent },
  );
  const n = result.version;
  await tx
    .update(editDocs)
    .set({ version: n, checkpointSeq: loaded.seq, meta: null, dirtySince: null })
    .where(eq(editDocs.artifactId, current.id));
  await compact(tx, current.id);
  await markFixed(deps, tx, current, n, meta?.fixes ?? []);
  lock.row = { ...row, version: n, checkpointSeq: loaded.seq, meta: null, dirtySince: null };
  lock.after(() => {
    void deps.events.emit(current.id, "version", { version: n });
    deps.docs?.notify(current.id, "c", { t: "checkpoint", version: n, kind: options.kind });
  });
  return { version: n, created: true, kind: options.kind };
}

/**
 * Threads that accepted suggestions or direct edits said they fix become fixed at this version, each
 * with a reply from the agent that fixed it (13, "Checkpoints", step 8).
 */
export async function markFixed(
  deps: Deps,
  tx: Tx,
  artifact: ArtifactRow,
  n: number,
  direct: Fix[],
  /** Accepted board batches this version carries, already stamped with it (14). */
  boards: (Omit<Fix, "n"> & { fixes: number[]; decidedBy: string | null })[] = [],
) {
  const articles = await tx
    .update(suggestions)
    .set({ version: n })
    .where(
      and(
        eq(suggestions.artifactId, artifact.id),
        eq(suggestions.status, "accepted"),
        isNull(suggestions.version),
      ),
    )
    .returning({
      fixes: suggestions.fixes,
      personId: suggestions.authorPersonId,
      agent: suggestions.agent,
      tokenId: suggestions.tokenId,
      decidedBy: suggestions.decidedBy,
    });
  const wanted = new Map<number, Fix & { acceptedBy: string | null }>();
  for (const fix of direct) wanted.set(fix.n, { ...fix, acceptedBy: null });
  for (const row of [...articles, ...boards]) {
    for (const thread of row.fixes) {
      wanted.set(thread, {
        n: thread,
        personId: row.personId,
        agent: row.agent,
        tokenId: row.tokenId,
        acceptedBy: row.decidedBy,
      });
    }
  }
  if (wanted.size === 0) return;
  const open = await tx
    .select({ id: threads.id, n: threads.n })
    .from(threads)
    .where(
      and(
        eq(threads.artifactId, artifact.id),
        inArray(threads.n, [...wanted.keys()]),
        inArray(threads.status, ["open"]),
      ),
    );
  if (open.length === 0) return;
  // An organization token has no person: its reply is its creator's, as everything it writes is (04).
  const tokenIds = [
    ...new Set([...wanted.values()].flatMap((fix) => (fix.personId ? [] : (fix.tokenId ?? [])))),
  ];
  const creators = new Map(
    tokenIds.length
      ? (
          await tx
            .select({ id: tokens.id, createdBy: tokens.createdBy })
            .from(tokens)
            .where(inArray(tokens.id, tokenIds))
        ).map((token) => [token.id, token.createdBy])
      : [],
  );
  const authorOf = (fix: Fix) =>
    fix.personId ?? (fix.tokenId ? creators.get(fix.tokenId) : undefined) ?? artifact.publisherId;
  const names = new Map(
    (
      await tx
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(
          inArray(people.id, [
            ...new Set(
              [...wanted.values()]
                .flatMap((fix) => [authorOf(fix), fix.acceptedBy])
                .filter(Boolean) as string[],
            ),
            artifact.publisherId,
          ]),
        )
    ).map((person) => [person.id, person.name]),
  );
  const now = deps.clock.now();
  await tx
    .update(threads)
    .set({ status: "fixed", fixedVersion: n })
    .where(
      inArray(
        threads.id,
        open.map((thread) => thread.id),
      ),
    );
  await tx.insert(comments).values(
    open.map((thread) => {
      const fix = wanted.get(thread.n) as Fix & { acceptedBy: string | null };
      const author = authorOf(fix);
      const by = fix.acceptedBy ? names.get(fix.acceptedBy) : null;
      return {
        id: Bun.randomUUIDv7(),
        threadId: thread.id,
        orgId: artifact.orgId,
        authorPersonId: author,
        authorName: names.get(author) ?? "Someone",
        agent: fix.agent,
        body: by ? `Fixed in v${n}, accepted by ${by}` : `Fixed in v${n}`,
        version: n,
        marksFixed: true,
        createdAt: now,
      };
    }),
  );
  // Fixing changes nothing a reader sees but the thread; a nudge lets open views refresh.
  for (const thread of open) void deps.events.emit(artifact.id, "thread", { thread: thread.n });
}

/** `checkpoint(deps, artifactId, options)`: the internal entry point, taking the lock itself (13). */
export async function checkpoint(
  deps: Deps,
  artifactId: string,
  options: CheckpointOptions,
): Promise<CheckpointResult> {
  const [place] = await deps.db
    .select({ row: artifacts, project: projects })
    .from(artifacts)
    .innerJoin(projects, eq(projects.id, artifacts.projectId))
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  if (!place) throw new ApiError("not_found", "No such artifact.");
  return withDocLock(deps, artifactId, (lock) => checkpointLocked(deps, lock, place, options));
}

/**
 * Before a publish or restore lands on an artifact with a draft (13, "When a version is made outside the
 * draft"), inside its lock: someone present refuses it with `live_draft`; a dirty draft is saved first as
 * a `handoff` checkpoint. `retire` then starts the draft again from the new version.
 */
export async function outsideDraft(
  deps: Deps,
  tx: Tx,
  place: Place,
  options: { discard?: boolean; by?: string | null } = {},
) {
  const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, place.row.id)).for("update");
  if (!row) return null;
  const queued: (() => void)[] = [];
  const lock: DocLock = { tx, row, after: (fn) => queued.push(fn) };
  if (row.snapshot.length > 0) {
    const [someone] = await tx
      .select({ id: editPresence.connectionId })
      .from(editPresence)
      .where(
        and(
          eq(editPresence.artifactId, row.artifactId),
          gt(editPresence.seenAt, new Date(deps.clock.now().getTime() - PRESENCE_TTL_MS)),
        ),
      )
      .limit(1);
    if (someone) {
      throw new ApiError(
        "conflict",
        "This page is being edited. Use artifacts_page_edit, or wait for them to save a version.",
        { reason: "live_draft" },
      );
    }
  }
  // In a savepoint, so a draft that can't be saved leaves the publish's transaction usable.
  let saved = false;
  try {
    saved = await tx.transaction(async (point) => {
      const inner: DocLock = { tx: point, row, after: lock.after };
      const result = await checkpointLocked(deps, inner, place, {
        kind: "handoff",
        personId: row.lastActorPersonId,
        agent: row.lastAgent,
      });
      lock.row = inner.row;
      return result.created;
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "invalid") throw error;
    if (!options.discard) {
      throw new ApiError(
        "conflict",
        `This page's draft can't be saved (${error.message}). Publish with discardDraft to drop it.`,
        { reason: "draft_invalid" },
      );
    }
    // The way out: the draft goes without a version, and the log says what was lost (13).
    await tx.insert(activity).values({
      id: Bun.randomUUIDv7(),
      orgId: place.row.orgId,
      artifactId: place.row.id,
      projectId: place.row.projectId,
      actorPersonId: options.by ?? row.lastActorPersonId ?? place.row.publisherId,
      agent: null,
      kind: "edited",
      payload: { discarded: true, seq: row.seq, since: row.version, reason: error.message },
      createdAt: deps.clock.now(),
    });
  }
  return {
    saved,
    retire: (version: number) => retireDoc(deps, lock, version),
    /** Editors hear of the checkpoint and the reset; call it once the caller's transaction committed. */
    flush() {
      for (const fn of queued.splice(0)) fn();
    },
  };
}

/** Threads named in a direct edit's `fixes` wait in the draft's meta until the checkpoint that carries them. */
export async function queueFixes(
  lock: DocLock,
  fixes: number[],
  by: { personId: string | null; agent: string | null; tokenId?: string | null },
) {
  if (!lock.row || fixes.length === 0) return;
  const meta = (lock.row.meta ?? {}) as NonNullable<typeof lock.row.meta> & { fixes?: Fix[] };
  const next = { ...meta, fixes: [...(meta.fixes ?? []), ...fixes.map((n) => ({ n, ...by }))].slice(-200) };
  await lock.tx.update(editDocs).set({ meta: next }).where(eq(editDocs.artifactId, lock.row.artifactId));
  lock.row = { ...lock.row, meta: next };
}
