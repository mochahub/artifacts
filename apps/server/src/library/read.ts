import { type LibraryRead, type LibraryView, READ_CHARS, READ_CHARS_MAX } from "@artifacts/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import { blocks, frames, pages, versions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import type { Loaded } from "./visible.ts";

type VersionRow = typeof versions.$inferSelect;

export async function liveVersion(deps: Deps, loaded: Loaded, n?: number): Promise<VersionRow> {
  const number = n ?? loaded.row.latestVersion;
  const [version] = Number.isSafeInteger(number)
    ? await deps.db
        .select()
        .from(versions)
        .where(
          and(eq(versions.artifactId, loaded.row.id), eq(versions.n, number), isNull(versions.deletedAt)),
        )
        .limit(1)
    : [];
  if (!version) throw new ApiError("not_found", "No such version.");
  return version;
}

type Item = LibraryRead["items"][number];

/** Everything a version says, in reading order: blocks of articles, frames of canvases. */
async function itemsOf(deps: Deps, version: VersionRow, onlyPage?: string): Promise<Item[]> {
  const [pageRows, blockRows, frameRows] = await Promise.all([
    deps.db.select().from(pages).where(eq(pages.versionId, version.id)).orderBy(pages.position),
    deps.db.select().from(blocks).where(eq(blocks.versionId, version.id)).orderBy(blocks.id),
    deps.db.select().from(frames).where(eq(frames.versionId, version.id)).orderBy(frames.y, frames.x),
  ]);
  const notes = version.notes as Record<string, string>;
  const items: Item[] = [];
  for (const page of pageRows) {
    if (onlyPage && page.pageKey !== onlyPage) continue;
    const base = { page: page.pageKey, kind: page.kind };
    if (page.kind === "article") {
      for (const block of blockRows.filter((row) => row.pageKey === page.pageKey)) {
        items.push({ ...base, ref: block.blockKey, title: null, text: block.text });
      }
    } else if (page.kind === "canvas") {
      for (const frame of frameRows.filter((row) => row.pageKey === page.pageKey)) {
        items.push({ ...base, ref: frame.frameKey, title: frame.title, text: notes[frame.frameKey] ?? "" });
      }
    } else if (page.kind === "gallery") {
      const list = ((page.meta as { items?: { caption?: string }[] }).items ?? []) as { caption?: string }[];
      list.forEach((item, index) => {
        items.push({ ...base, ref: `item-${index + 1}`, title: null, text: item.caption ?? "" });
      });
    } else {
      items.push({ ...base, ref: null, title: page.title, text: "" });
    }
  }
  return items;
}

const parseCursor = (cursor: string | undefined) => {
  if (!cursor) return { item: 0, offset: 0 };
  const match = /^(\d{1,9}):(\d{1,9})$/.exec(cursor);
  if (!match) throw new ApiError("invalid", "That cursor isn't valid.");
  return { item: Number(match[1]), offset: Number(match[2]) };
};

/**
 * One piece of an artifact's text. A piece is a budget of characters, not a count of items, so a long
 * document can't arrive in one answer. One block can be longer than that, so the cursor can stop mid-block.
 */
export async function readArtifact(
  deps: Deps,
  loaded: Loaded,
  options: { page?: string; version?: number; cursor?: string; chars?: number },
): Promise<LibraryRead> {
  const budget = Math.min(Math.max(options.chars ?? READ_CHARS, 200), READ_CHARS_MAX);
  const version = await liveVersion(deps, loaded, options.version);
  const all = await itemsOf(deps, version, options.page);
  if (options.page && all.length === 0) {
    const [page] = await deps.db
      .select({ key: pages.pageKey })
      .from(pages)
      .where(and(eq(pages.versionId, version.id), eq(pages.pageKey, options.page)))
      .limit(1);
    if (!page) throw new ApiError("not_found", "That page isn't in this version.");
  }
  const start = parseCursor(options.cursor);
  const items: Item[] = [];
  let left = budget;
  let index = start.item;
  let offset = start.offset;
  while (index < all.length && left > 0) {
    const item = all[index] as Item;
    const piece = item.text.slice(offset, offset + left);
    items.push({ ...item, text: piece });
    left -= piece.length + 40;
    if (offset + piece.length < item.text.length) {
      offset += piece.length;
      break;
    }
    index += 1;
    offset = 0;
  }
  return {
    project: loaded.projectSlug,
    slug: loaded.row.slug,
    title: loaded.row.title,
    version: version.n,
    items,
    nextCursor: index < all.length ? `${index}:${offset}` : null,
  };
}

/** Which picture to show. A thumbnail by default; the frame's @1x or @2x when asked. */
export async function viewArtifact(
  deps: Deps,
  loaded: Loaded,
  options: { page?: string; frame?: string; size?: string; version?: number },
): Promise<LibraryView> {
  const size = options.size === "1x" || options.size === "2x" ? options.size : "thumb";
  if (options.size && options.size !== size && options.size !== "thumb") {
    throw new ApiError("invalid", "size is thumb, 1x or 2x.");
  }
  const version = await liveVersion(deps, loaded, options.version);
  const image = (hash: string | undefined) =>
    hash ? `/api/artifacts/${loaded.row.id}/r/${hash}?via=app` : null;
  const rows = await deps.db
    .select()
    .from(frames)
    .where(
      and(
        eq(frames.versionId, version.id),
        options.page ? eq(frames.pageKey, options.page) : undefined,
        options.frame ? eq(frames.frameKey, options.frame) : undefined,
      ),
    )
    .orderBy(frames.y, frames.x)
    .limit(1);
  const frame = rows[0];
  if (frame) {
    return {
      page: frame.pageKey,
      frame: frame.frameKey,
      title: frame.title,
      size,
      image: image((frame.renders as Record<string, string>)[size]),
    };
  }
  if (options.frame) throw new ApiError("not_found", "That frame isn't in this version.");
  // No frames to show here: an article or a micro app has its share picture.
  const files = version.files as Record<string, { hash: string }>;
  return {
    page: options.page ?? null,
    frame: null,
    title: loaded.row.title,
    size: "thumb",
    image: image(files["__og.webp"]?.hash),
  };
}
