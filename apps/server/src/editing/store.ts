import { createHash } from "node:crypto";
import {
  type BoardKind,
  boardStamp,
  boardToY,
  emptyBoard,
  newObject,
  validateBoard,
} from "@artifacts/doc/board";
import { mintBoardObjectId } from "@artifacts/doc/board-ids";
import { keysBetween } from "@artifacts/doc/board-order";
import {
  type AtomKind,
  EDIT_COMPACT_BYTES,
  EDIT_COMPACT_UPDATES,
  MANIFEST,
  type NOT_EDITABLE_REASONS,
} from "@artifacts/schema";
import {
  type BoardObject,
  type BoardSnapshot,
  BoardSnapshot as BoardSnapshotSchema,
} from "@artifacts/schema/boards";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import * as Y from "yjs";
import { findArtifact, type LoadedArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import type { Tx } from "../db/index.ts";
import { lockArtifact } from "../db/locks.ts";
import {
  blockAliases,
  blocks,
  boardSuggestions,
  boardVersions,
  editAtoms,
  editAuthors,
  editDocs,
  editRuns,
  editUpdates,
  frames,
  pages,
  suggestions,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../layout.ts";
import { docToY, markdownToDoc, mintBlockId, contentHash as nodeHash, topBlocks } from "./model.ts";

export type DocRow = typeof editDocs.$inferSelect;
type Reason = (typeof NOT_EDITABLE_REASONS)[number];

/**
 * Who changed the draft: a person in the editor, an agent through a token (with the person it acts
 * for, null for an organization token), or the server's own fixes.
 */
export type Actor = {
  origin: "person" | "agent" | "server";
  personId: string | null;
  agent: string | null;
  tokenId: string | null;
};

/** The actor for a caller. A browser session is a person; any token is an agent (04). */
export function editActor(
  caller: Extract<Caller, { kind: "person" | "cliToken" | "orgToken" }>,
  agent: string | null,
): Actor {
  if (caller.kind === "person")
    return { origin: "person", personId: caller.person.id, agent: null, tokenId: null };
  return {
    origin: "agent",
    personId: caller.kind === "cliToken" ? caller.person.id : null,
    agent: agent?.trim() || "agent",
    tokenId: caller.tokenId,
  };
}

/** A transaction holding the artifact's lock and its draft row, and what to do once it commits. */
export type DocLock = { tx: Tx; row: DocRow | null; after(fn: () => void): void };

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const EMPTY = new Uint8Array();
const notEditable = (reason: Reason, message = "This page can't be edited here.") =>
  new ApiError("conflict", message, { reason: "not_editable", editable: reason });

/**
 * The one lock order for anything that makes a version (13, "Checkpoints"): the artifact's advisory lock,
 * then its draft row, then (inside `fn`) the artifacts row. Notifications queued with `after` go out
 * once the transaction has committed.
 */
export async function withDocLock<T>(
  deps: Deps,
  artifactId: string,
  fn: (lock: DocLock) => Promise<T>,
): Promise<T> {
  const queued: (() => void)[] = [];
  const result = await deps.db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId, "content");
    const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, artifactId)).for("update");
    return fn({ tx, row: row ?? null, after: (next) => queued.push(next) });
  });
  for (const next of queued) next();
  return result;
}

/** What a draft holds: an article's ProseMirror fragment or a board's object maps (14). */
export type DocKind = "article" | "board";
export type EditableState =
  | { editable: true; pageKey: string; kind: DocKind }
  | { editable: false; reason: Reason };

/**
 * What the page is, for editing: `DocState.reason` when it can't be (13, "Concepts"). One article page
 * is an article draft; one canvas page of a wiki `page` (not a source) is a board draft (14, "Concepts
 * and eligibility"). Any other shape keeps the article reason `not_article`; board routes call it
 * `not_canvas`.
 */
export async function editability(deps: Deps, artifact: LoadedArtifact): Promise<EditableState> {
  if (artifact.project.kind !== "wiki") return { editable: false, reason: "not_wiki" };
  if (artifact.row.archivedAt || artifact.row.deletedAt) return { editable: false, reason: "archived" };
  if (artifact.row.hasBackend) return { editable: false, reason: "has_backend" };
  const rows = await deps.db
    .select({ key: pages.pageKey, kind: pages.kind, wiki: versions.wiki })
    .from(pages)
    .innerJoin(versions, eq(versions.id, pages.versionId))
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(2);
  const [page] = rows;
  if (rows.length !== 1 || !page) return { editable: false, reason: "not_article" };
  if (page.kind === "article") return { editable: true, pageKey: page.key, kind: "article" };
  if (page.kind === "canvas" && (page.wiki?.role ?? "page") === "page")
    return { editable: true, pageKey: page.key, kind: "board" };
  return { editable: false, reason: "not_article" };
}

async function blobText(deps: Deps, hash: string | undefined) {
  if (!hash) return null;
  const object = await deps.bucket.get(blobKey(hash));
  return object ? new TextDecoder().decode(object.body) : null;
}

/** The SVG the read pipeline drew for one block of a version's article HTML, or null if it can't be cut. */
export function cutSvg(html: string, key: string): string | null {
  const at = html.indexOf(`data-block="${key}"`);
  if (at < 0) return null;
  const start = html.indexOf("<svg", at);
  const end = html.indexOf("</svg>", start);
  const next = html.indexOf("data-block=", at + key.length + 12);
  if (start < 0 || end < 0 || (next >= 0 && next < start)) return null;
  return html.slice(start, end + "</svg>".length);
}

type PmNode = { type: string; attrs?: Record<string, unknown>; content?: PmNode[]; marks?: unknown[] };

/** Marks every text node with one author, for a draft seeded from a version (13, "Seeding"). */
function markAll(node: PmNode, mark: { type: "author"; attrs: { a: string; t: number } }): PmNode {
  if (node.type === "text") return { ...node, marks: [...(node.marks ?? []), mark] };
  return node.content ? { ...node, content: node.content.map((child) => markAll(child, mark)) } : node;
}

/**
 * Seeds the draft from the latest version, under the lock: ids from `meta.blockIds` or minted (with
 * `block_aliases` for the version's legacy keys), atoms into `edit_atoms`, and every passage marked as
 * the version's publisher's. A retired draft (empty snapshot, after a publish outside it) keeps its row,
 * so `seq` never goes back.
 */
async function seed(deps: Deps, lock: DocLock, artifact: LoadedArtifact): Promise<DocRow> {
  const state = await editability(deps, artifact);
  if (!state.editable) throw notEditable(state.reason);
  if (state.kind === "board") return seedBoard(deps, lock, artifact, state.pageKey);
  const { tx } = lock;
  const [version] = await tx
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  const [page] = version
    ? await tx
        .select()
        .from(pages)
        .where(and(eq(pages.versionId, version.id), eq(pages.pageKey, state.pageKey)))
        .limit(1)
    : [];
  if (!version || !page) throw notEditable("not_article");
  const manifest = JSON.parse((await blobText(deps, version.files[MANIFEST]?.hash)) ?? "{}") as {
    pages?: { id: string; src?: string }[];
  };
  const src = manifest.pages?.find((entry) => entry.id === state.pageKey)?.src;
  const markdown = src ? await blobText(deps, version.files[src]?.hash) : null;
  if (!src || markdown === null) throw notEditable("not_article");

  const atoms = new Map<string, { kind: AtomKind; source: string }>();
  const lasting = page.meta.blockIds;
  const { doc, ids } = markdownToDoc(markdown, {
    ids: lasting,
    mint: mintBlockId,
    atom(kind: AtomKind, source: string) {
      const hash = sha256(source);
      atoms.set(hash, { kind, source });
      return hash;
    },
  });
  const top = ((doc as PmNode).content ?? []) as PmNode[];

  // What each draft block was called in the version: its id, or its legacy key by hash, then position.
  const legacy = lasting
    ? []
    : await tx
        .select({ key: blocks.blockKey, hash: blocks.contentHash })
        .from(blocks)
        .where(and(eq(blocks.versionId, version.id), eq(blocks.pageKey, state.pageKey)))
        .orderBy(asc(blocks.id));
  const keyOf = new Map<number, string>();
  if (lasting) for (const [index, id] of ids.entries()) keyOf.set(index, id);
  else {
    const used = new Set<number>();
    top.forEach((node, index) => {
      const hash = nodeHash(node as never);
      const found = legacy.findIndex((row, at) => !used.has(at) && row.hash === hash);
      const at = found >= 0 ? found : legacy.length === top.length && !used.has(index) ? index : -1;
      if (at < 0) return;
      used.add(at);
      keyOf.set(index, (legacy[at] as { key: string }).key);
    });
  }

  const svgs = new Map<string, string>();
  const mermaid = top.flatMap((node, index) =>
    node.type === "atom" && node.attrs?.kind === "mermaid" ? [{ index, hash: String(node.attrs.hash) }] : [],
  );
  if (mermaid.length) {
    const html = (await blobText(deps, page.meta.htmlHash)) ?? "";
    for (const { index, hash } of mermaid) {
      const key = keyOf.get(index);
      const svg = key ? cutSvg(html, key) : null;
      if (!svg) throw notEditable("redraw", "Republish this page with the CLI to edit it here.");
      svgs.set(hash, svg);
    }
  }

  const t = Math.floor(version.publishedAt.getTime() / 60_000);
  const ydoc = docToY(markAll(doc as PmNode, { type: "author", attrs: { a: "a1", t } }) as never);
  const snapshot = Y.encodeStateAsUpdate(ydoc);
  const now = deps.clock.now();
  const orgId = artifact.row.orgId;

  let row: DocRow | undefined;
  if (lock.row) {
    [row] = await tx
      .update(editDocs)
      .set({
        pageKey: state.pageKey,
        kind: "article",
        baseVersion: version.n,
        version: version.n,
        seq: sql`${editDocs.seq} + 1`,
        checkpointSeq: sql`${editDocs.seq} + 1`,
        snapshotSeq: sql`${editDocs.seq} + 1`,
        snapshot,
        meta: null,
        dirtySince: null,
        updatedAt: now,
      })
      .where(eq(editDocs.artifactId, artifact.id))
      .returning();
  } else {
    [row] = await tx
      .insert(editDocs)
      .values({
        artifactId: artifact.id,
        orgId,
        pageKey: state.pageKey,
        kind: "article",
        baseVersion: version.n,
        version: version.n,
        seq: 1,
        checkpointSeq: 1,
        snapshotSeq: 1,
        snapshot,
        authorCounter: 0,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id));
  }
  if (!row) throw new Error("no edit_docs row");

  if (atoms.size) {
    await tx
      .insert(editAtoms)
      .values(
        [...atoms].map(([hash, atom]) => ({
          artifactId: artifact.id,
          hash,
          orgId,
          kind: atom.kind,
          source: atom.source,
          svg: svgs.get(hash) ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [editAtoms.artifactId, editAtoms.hash],
        set: { svg: sql`coalesce(excluded.svg, ${editAtoms.svg})` },
      });
  }
  const publisher: Actor = {
    origin: version.agent ? "agent" : "person",
    personId: version.publishedBy,
    agent: version.agent,
    tokenId: null,
  };
  // The seeded text's author is `a1` on a new draft; on a reseed, whatever key that author already has.
  const key = await authorKeyIn(tx, row, publisher, []);
  if (key !== "a1") {
    const again = docToY(markAll(doc as PmNode, { type: "author", attrs: { a: key, t } }) as never);
    const bytes = Y.encodeStateAsUpdate(again);
    await tx.update(editDocs).set({ snapshot: bytes }).where(eq(editDocs.artifactId, artifact.id));
    row = { ...row, snapshot: bytes };
  }
  if (!lasting && keyOf.size) {
    await tx
      .insert(blockAliases)
      .values(
        [...keyOf].map(([index, legacyKey]) => ({
          artifactId: artifact.id,
          legacyKey,
          orgId,
          blockId: ids[index] as string,
          version: version.n,
        })),
      )
      .onConflictDoUpdate({
        target: [blockAliases.artifactId, blockAliases.legacyKey],
        set: { blockId: sql`excluded.block_id`, version: sql`excluded.version` },
      });
  }
  return { ...row, authorCounter: Math.max(row.authorCounter, 1) };
}

/**
 * The board a version holds (14, "Read compatibility and first edit"): its checkpointed native snapshot,
 * or, for a legacy CLI canvas, each board group as a native container frame and each CLI frame as a
 * child `rendered_frame` at its exact world position, with the raw `{ page, board, frame }` source tuple.
 * Ids are minted here once and persisted with the seed. Everything is stamped by `stamp`.
 */
export async function versionBoard(
  tx: Tx,
  version: { id: string; n: number },
  pageKey: string,
  meta: { boards?: { key: string; title: string; x: number; y: number; w: number; h: number }[] },
  stamp: { a: string; t: string },
): Promise<BoardSnapshot> {
  const [native] = await tx
    .select({ snapshot: boardVersions.snapshot })
    .from(boardVersions)
    .where(and(eq(boardVersions.versionId, version.id), eq(boardVersions.pageKey, pageKey)))
    .limit(1);
  if (native) return BoardSnapshotSchema.parse(native.snapshot);
  const rows = await tx
    .select()
    .from(frames)
    .where(and(eq(frames.versionId, version.id), eq(frames.pageKey, pageKey)))
    .orderBy(asc(frames.boardKey), asc(frames.frameKey));
  const style = {
    fill: "transparent" as const,
    stroke: "#242424",
    strokeWidth: 2,
    opacity: 1,
    fontSize: 20,
    align: "left" as const,
  };
  const size = (n: number) => Math.min(100_000, Math.max(1, n));
  const objects: BoardObject[] = [];
  const groups = meta.boards ?? [];
  const groupOrders = keysBetween(null, null, groups.length);
  const groupIds = new Map<string, { id: string; x: number; y: number }>();
  for (const [index, board] of groups.entries()) {
    const id = mintBoardObjectId();
    groupIds.set(board.key, { id, x: board.x, y: board.y });
    const kind: BoardKind = "frame";
    objects.push(
      newObject(
        {
          id,
          kind,
          pose: { x: board.x, y: board.y, w: size(board.w), h: size(board.h), angle: 0 },
          parent: null,
          order: groupOrders[index] as string,
          label: board.title.slice(0, 280),
          style,
        },
        stamp,
      ),
    );
  }
  const counts = new Map<string | null, number>();
  for (const frame of rows) {
    const parent = groupIds.get(frame.boardKey)?.id ?? null;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const orders = new Map([...counts].map(([parent, n]) => [parent, keysBetween(null, null, n)]));
  const used = new Map<string | null, number>();
  for (const frame of rows) {
    const group = groupIds.get(frame.boardKey);
    const parent = group?.id ?? null;
    const at = used.get(parent) ?? 0;
    used.set(parent, at + 1);
    objects.push(
      newObject(
        {
          id: mintBoardObjectId(),
          kind: "rendered_frame",
          pose: {
            x: frame.x - (group?.x ?? 0),
            y: frame.y - (group?.y ?? 0),
            w: size(frame.w),
            h: size(frame.h),
            angle: 0,
          },
          parent,
          order: orders.get(parent)?.[at] as string,
          label: (frame.title ?? "").slice(0, 280),
          style,
          data: {
            source: { page: pageKey, board: frame.boardKey, frame: frame.frameKey },
            version: version.n,
            contentHash: frame.contentHash,
            renders: frame.renders,
            intrinsic: { w: size(frame.w), h: size(frame.h) },
            livePath: frame.livePath ?? null,
            missing: false,
          },
        },
        stamp,
      ),
    );
  }
  return { ...emptyBoard(pageKey), objects };
}

async function boardAssetHashes(tx: Tx, artifactId: string): Promise<Set<string>> {
  const rows = await tx.execute(
    sql`select hash from board_assets where artifact_id = ${artifactId} and validated_at is not null`,
  );
  return new Set((rows as unknown as { hash: string }[]).map((row) => row.hash));
}

/** Seeds a board draft: the version's board, checked as sync would check it, then the row (14). */
async function seedBoard(
  deps: Deps,
  lock: DocLock,
  artifact: LoadedArtifact,
  pageKey: string,
): Promise<DocRow> {
  const { tx } = lock;
  const [version] = await tx
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  const [page] = version
    ? await tx
        .select()
        .from(pages)
        .where(and(eq(pages.versionId, version.id), eq(pages.pageKey, pageKey)))
        .limit(1)
    : [];
  if (!version || !page) throw notEditable("not_article");
  const t = boardStamp("a1", version.publishedAt.getTime()).t;
  const build = async (a: string) => {
    const snapshot = await versionBoard(tx, version, pageKey, page.meta, { a, t });
    const parsed = BoardSnapshotSchema.safeParse(snapshot);
    const ydoc = boardToY(parsed.success ? parsed.data : snapshot);
    const check = parsed.success
      ? validateBoard(ydoc, { assets: await boardAssetHashes(tx, artifact.id) })
      : { ok: false as const, reason: parsed.error.issues[0]?.message ?? "invalid" };
    if (!check.ok) {
      deps.log.warn("couldn't seed a board draft", { artifact: artifact.id, reason: check.reason });
      throw notEditable("redraw", "Republish this board with the CLI to edit it here.");
    }
    const bytes = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    return bytes;
  };
  let snapshot = await build("a1");
  const now = deps.clock.now();
  let row: DocRow | undefined;
  if (lock.row) {
    [row] = await tx
      .update(editDocs)
      .set({
        pageKey,
        kind: "board",
        baseVersion: version.n,
        version: version.n,
        seq: sql`${editDocs.seq} + 1`,
        checkpointSeq: sql`${editDocs.seq} + 1`,
        snapshotSeq: sql`${editDocs.seq} + 1`,
        snapshot,
        meta: null,
        dirtySince: null,
        updatedAt: now,
      })
      .where(eq(editDocs.artifactId, artifact.id))
      .returning();
  } else {
    [row] = await tx
      .insert(editDocs)
      .values({
        artifactId: artifact.id,
        orgId: artifact.row.orgId,
        pageKey,
        kind: "board",
        baseVersion: version.n,
        version: version.n,
        seq: 1,
        checkpointSeq: 1,
        snapshotSeq: 1,
        snapshot,
        authorCounter: 0,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id));
  }
  if (!row) throw new Error("no edit_docs row");
  const publisher: Actor = {
    origin: version.agent ? "agent" : "person",
    personId: version.publishedBy,
    agent: version.agent,
    tokenId: null,
  };
  // A legacy seed's stamps are the publisher's key; a native snapshot keeps the keys it already has.
  const key = await authorKeyIn(tx, row, publisher, []);
  if (key !== "a1") {
    snapshot = await build(key);
    await tx.update(editDocs).set({ snapshot }).where(eq(editDocs.artifactId, artifact.id));
    row = { ...row, snapshot };
  }
  return { ...row, authorCounter: Math.max(row.authorCounter, 1) };
}

/** The draft's row, seeding it under the lock when there is none (or it was retired). */
export async function ensureDoc(deps: Deps, artifact: LoadedArtifact): Promise<DocRow> {
  const [row] = await deps.db.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id));
  if (row && row.snapshot.length > 0) return row;
  return withDocLock(deps, artifact.id, async (lock) =>
    lock.row && lock.row.snapshot.length > 0 ? lock.row : seed(deps, lock, artifact),
  );
}

/** Seeds inside a lock someone already holds (operations, checkpoints). */
export async function ensureDocLocked(deps: Deps, lock: DocLock, artifact: LoadedArtifact): Promise<DocRow> {
  if (lock.row && lock.row.snapshot.length > 0) return lock.row;
  const row = await seed(deps, lock, artifact);
  lock.row = row;
  return row;
}

/**
 * The draft as a Y.Doc: the snapshot, then every update after it in this epoch, in order (13, "Loading").
 * Seeds first if needed. Pass a lock to read inside it.
 */
export async function loadDoc(
  deps: Deps,
  artifactId: string,
  lock?: DocLock,
): Promise<{ ydoc: Y.Doc; row: DocRow }> {
  let row: DocRow;
  if (lock) {
    const artifact = lock.row?.snapshot.length
      ? null
      : await findArtifact(deps, await orgOf(deps, artifactId), artifactId);
    row = artifact ? await ensureDocLocked(deps, lock, artifact) : (lock.row as DocRow);
  } else {
    const [found] = await deps.db.select().from(editDocs).where(eq(editDocs.artifactId, artifactId));
    if (found && found.snapshot.length > 0) row = found;
    else {
      const artifact = await findArtifact(deps, await orgOf(deps, artifactId), artifactId);
      if (!artifact) throw new ApiError("not_found", "No such artifact.");
      row = await ensureDoc(deps, artifact);
    }
  }
  const db = lock?.tx ?? deps.db;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row.snapshot);
  // In pages, so a long run of updates since the snapshot is read whole, never cut off.
  const PAGE = EDIT_COMPACT_UPDATES * 20;
  let last = row.snapshotSeq;
  for (;;) {
    const page = await db
      .select({ seq: editUpdates.seq, update: editUpdates.update })
      .from(editUpdates)
      .where(
        and(
          eq(editUpdates.artifactId, artifactId),
          eq(editUpdates.epoch, row.epoch),
          gt(editUpdates.seq, last),
        ),
      )
      .orderBy(asc(editUpdates.seq))
      .limit(PAGE);
    for (const { update } of page) Y.applyUpdate(ydoc, update);
    last = page.at(-1)?.seq ?? last;
    if (page.length < PAGE) break;
  }
  return { ydoc, row: { ...row, seq: Math.max(row.seq, last) } };
}

async function orgOf(deps: Deps, artifactId: string) {
  const [row] = await deps.db
    .select({ orgId: editDocs.orgId })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifactId))
    .limit(1);
  if (row) return row.orgId;
  const found = await deps.db.execute(sql`select org_id from artifacts where id = ${artifactId} limit 1`);
  const [first] = found as unknown as { org_id: string }[];
  if (!first) throw new ApiError("not_found", "No such artifact.");
  return first.org_id;
}

/**
 * Persists one (coalesced) update (13, "Writing an update"): the row lock orders writers per page, and
 * the notifications go out after the commit. Inside a lock, it uses that transaction. Returns the seq.
 */
export async function persistUpdate(
  deps: Deps,
  artifactId: string,
  update: Uint8Array,
  actor: Actor,
  lock?: DocLock,
  /** The epoch the update was made on. A socket's late write after a reset is refused, not stamped new. */
  epoch?: number,
): Promise<number> {
  const write = async (tx: Tx, after: (fn: () => void) => void) => {
    const now = deps.clock.now();
    const person = actor.origin === "server" ? sql`${editDocs.lastActorPersonId}` : actor.personId;
    const [row] = await tx
      .update(editDocs)
      .set({
        seq: sql`${editDocs.seq} + 1`,
        updatedAt: now,
        dirtySince: sql`coalesce(${editDocs.dirtySince}, ${now.toISOString()}::timestamptz)`,
        lastActorPersonId: person as never,
        lastAgent: actor.origin === "server" ? sql`${editDocs.lastAgent}` : actor.agent,
      })
      .where(
        epoch === undefined
          ? eq(editDocs.artifactId, artifactId)
          : and(eq(editDocs.artifactId, artifactId), eq(editDocs.epoch, epoch)),
      )
      .returning({
        seq: editDocs.seq,
        epoch: editDocs.epoch,
        orgId: editDocs.orgId,
        snapshotSeq: editDocs.snapshotSeq,
      });
    if (!row && epoch !== undefined)
      throw new ApiError("conflict", "The draft was started again.", { reason: "stale" });
    if (!row) throw new ApiError("not_found", "This page has no draft.");
    await tx.insert(editUpdates).values({
      artifactId,
      seq: row.seq,
      orgId: row.orgId,
      epoch: row.epoch,
      update,
      actorPersonId: actor.personId,
      agent: actor.agent,
      tokenId: actor.tokenId,
      origin: actor.origin,
      size: update.length,
    });
    await maybeCompact(tx, artifactId, row);
    after(() => announce(deps, artifactId, row.seq));
    return row.seq;
  };
  if (lock) return write(lock.tx, lock.after);
  const queued: (() => void)[] = [];
  const seq = await deps.db.transaction((tx) => write(tx, (fn) => queued.push(fn)));
  for (const fn of queued) fn();
  return seq;
}

/** Other replicas and editors hear of a new update; the `draft` event nudges draft views (13). */
export function announce(deps: Deps, artifactId: string, seq: number) {
  deps.docs?.notify(artifactId, "u", { seq });
  void deps.events.emit(artifactId, "draft", { seq });
}

async function maybeCompact(
  tx: Tx,
  artifactId: string,
  row: { seq: number; epoch: number; snapshotSeq: number },
) {
  const pending = row.seq - row.snapshotSeq;
  if (pending <= EDIT_COMPACT_UPDATES) {
    const [sum] = await tx
      .select({ bytes: sql<number>`coalesce(sum(${editUpdates.size}), 0)::int` })
      .from(editUpdates)
      .where(and(eq(editUpdates.artifactId, artifactId), gt(editUpdates.seq, row.snapshotSeq)));
    if ((sum?.bytes ?? 0) <= EDIT_COMPACT_BYTES) return;
  }
  await compact(tx, artifactId);
}

/** Folds the updates since the snapshot into it, and deletes them (13, "Compaction"). Under the row lock. */
export async function compact(tx: Tx, artifactId: string) {
  const [row] = await tx
    .select({
      seq: editDocs.seq,
      epoch: editDocs.epoch,
      snapshot: editDocs.snapshot,
      snapshotSeq: editDocs.snapshotSeq,
    })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifactId));
  if (!row || row.snapshot.length === 0) return;
  const updates = await tx
    .select({ seq: editUpdates.seq, update: editUpdates.update })
    .from(editUpdates)
    .where(
      and(
        eq(editUpdates.artifactId, artifactId),
        eq(editUpdates.epoch, row.epoch),
        gt(editUpdates.seq, row.snapshotSeq),
        lte(editUpdates.seq, row.seq),
      ),
    )
    .orderBy(asc(editUpdates.seq));
  if (updates.length === 0) return;
  // Through a document, not Y.mergeUpdates: merging keeps deleted text, and a document collects it, so
  // what someone deleted (a pasted secret, say) doesn't live on in the snapshot.
  const folded = new Y.Doc({ gc: true });
  Y.applyUpdate(folded, row.snapshot);
  for (const entry of updates) Y.applyUpdate(folded, entry.update);
  const snapshot = Y.encodeStateAsUpdate(folded);
  folded.destroy();
  const upTo = updates.at(-1)?.seq ?? row.seq;
  await tx.update(editDocs).set({ snapshot, snapshotSeq: upTo }).where(eq(editDocs.artifactId, artifactId));
  await tx.delete(editUpdates).where(and(eq(editUpdates.artifactId, artifactId), lte(editUpdates.seq, upTo)));
}

/**
 * Retires the draft after a version landed outside it (13, "Epochs and seq"): the next epoch, seeded
 * lazily from the new version; the old epoch's updates gone; open suggestions stale; active runs
 * cancelled. Under the lock. Editors get control `reset` after the commit.
 */
export async function retireDoc(deps: Deps, lock: DocLock, version: number) {
  const { tx, row } = lock;
  if (!row) return;
  const now = deps.clock.now();
  await tx
    .update(editDocs)
    .set({
      epoch: sql`${editDocs.epoch} + 1`,
      baseVersion: version,
      version,
      snapshot: EMPTY,
      checkpointSeq: sql`${editDocs.seq}`,
      snapshotSeq: sql`${editDocs.seq}`,
      meta: null,
      dirtySince: null,
      updatedAt: now,
    })
    .where(eq(editDocs.artifactId, row.artifactId));
  await tx.delete(editUpdates).where(eq(editUpdates.artifactId, row.artifactId));
  await tx
    .update(suggestions)
    .set({ status: "stale", decidedAt: now })
    .where(and(eq(suggestions.artifactId, row.artifactId), eq(suggestions.status, "open")));
  await tx
    .update(boardSuggestions)
    .set({ status: "stale", decidedAt: now })
    .where(and(eq(boardSuggestions.artifactId, row.artifactId), eq(boardSuggestions.status, "open")));
  await tx
    .update(editRuns)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(eq(editRuns.artifactId, row.artifactId), eq(editRuns.status, "active")));
  const epoch = row.epoch + 1;
  lock.after(() => deps.docs?.notify(row.artifactId, "c", { t: "reset", epoch, version }));
}

/** An author's key on this page, made once per author and set of sources (13, "Attribution"). */
export async function authorKey(
  deps: Deps,
  artifactId: string,
  actor: Actor,
  sources: string[],
  lock?: DocLock,
): Promise<string> {
  if (lock?.row) return authorKeyIn(lock.tx, lock.row, actor, sources);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(editDocs).where(eq(editDocs.artifactId, artifactId));
    if (!row) throw new ApiError("not_found", "This page has no draft.");
    return authorKeyIn(tx, row, actor, sources);
  });
}

async function authorKeyIn(
  tx: Tx,
  row: Pick<DocRow, "artifactId" | "orgId">,
  actor: Actor,
  sources: string[],
): Promise<string> {
  const kind = actor.agent ? ("agent" as const) : ("person" as const);
  const sorted = [...new Set(sources)].sort();
  const fingerprint = sha256(JSON.stringify([kind, actor.personId, actor.agent, actor.tokenId, sorted]));
  const find = async () => {
    const [found] = await tx
      .select({ key: editAuthors.key })
      .from(editAuthors)
      .where(and(eq(editAuthors.artifactId, row.artifactId), eq(editAuthors.fingerprint, fingerprint)))
      .limit(1);
    return found?.key ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  const [counter] = await tx
    .update(editDocs)
    .set({ authorCounter: sql`${editDocs.authorCounter} + 1` })
    .where(eq(editDocs.artifactId, row.artifactId))
    .returning({ n: editDocs.authorCounter });
  const key = `a${counter?.n ?? 1}`;
  const made = await tx
    .insert(editAuthors)
    .values({
      artifactId: row.artifactId,
      key,
      orgId: row.orgId,
      kind,
      personId: actor.personId,
      agent: actor.agent,
      tokenId: actor.tokenId,
      sources: sorted,
      fingerprint,
    })
    .onConflictDoNothing()
    .returning({ key: editAuthors.key });
  return made[0]?.key ?? (await find()) ?? key;
}

/** The ids of the draft's top-level blocks, in order. */
export const draftBlockIds = (ydoc: Y.Doc) => topBlocks(ydoc).map((block: { id: string }) => block.id);
