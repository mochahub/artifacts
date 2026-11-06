import type { PageMeta, VersionDetail, VersionRow } from "@artifacts/schema";
import { agentLabel } from "@artifacts/schema";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { blocks, decisions, frames, pages, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { artifactParam } from "../http/resources.ts";
import type { Routes } from "../http/routes.ts";
import {
  type Changes,
  changedSince,
  changes,
  hashesOf,
  keyOf,
  type VersionHashes,
} from "../versions/diff.ts";
import { listVersions } from "../versions/list.ts";

const boardIndex = (meta: PageMeta, key: string) =>
  (meta.boards ?? []).findIndex((board) => board.key === key);

export function versionRoutes(routes: Routes, deps: Deps) {
  const { db } = deps;
  const artifact = artifactParam(deps);

  routes.get("/api/artifacts/:id/versions", { action: "artifact.read", resource: artifact }, async (c) => {
    const { id } = c.var.resource;
    const [rows, decided] = await Promise.all([
      listVersions(deps, id),
      db.select().from(decisions).where(eq(decisions.artifactId, id)).orderBy(desc(decisions.createdAt)),
    ]);
    // Each version is compared with the one before it, so each is read once, not twice.
    const read = new Map<string, Promise<VersionHashes>>();
    const once = (versionId: string) => {
      const known = read.get(versionId) ?? hashesOf(db, versionId);
      read.set(versionId, known);
      return known;
    };
    const count = ({ added, removed, changed }: Changes) => added.length + removed.length + changed.length;
    const counts = await Promise.all(
      rows.map(async ({ version }, index) => {
        const previous = rows[index + 1]?.version;
        if (!previous) return { frames: 0, blocks: 0 };
        const [now, then] = await Promise.all([once(version.id), once(previous.id)]);
        return {
          frames: count(changes(then.frames, now.frames)),
          blocks: count(changes(then.blocks, now.blocks)),
        };
      }),
    );
    return etagJson(
      c,
      rows.map(({ version, by }, index) => ({
        n: version.n,
        name: version.name,
        message: version.message,
        publishedBy: by,
        agent: version.agent ? agentLabel(by, version.agent) : null,
        publishedAt: version.publishedAt.toISOString(),
        restoredFrom: version.restoredFrom,
        summary: version.summary,
        tags: version.tags ?? [],
        decision: decided.find((entry) => entry.version === version.n)?.kind,
        changes: counts[index] ?? { frames: 0, blocks: 0 },
      })) satisfies VersionRow[],
    );
  });

  routes.get("/api/artifacts/:id/versions/:n", { action: "artifact.read", resource: artifact }, async (c) => {
    const { id } = c.var.resource;
    const n = Number(c.req.param("n"));
    const [version] = Number.isInteger(n)
      ? await db
          .select()
          .from(versions)
          .where(and(eq(versions.artifactId, id), eq(versions.n, n), isNull(versions.deletedAt)))
          .limit(1)
      : [];
    if (!version) throw new ApiError("not_found", "Not found.");
    const [previous] = await db
      .select({ id: versions.id, n: versions.n })
      .from(versions)
      .where(and(eq(versions.artifactId, id), lt(versions.n, n), isNull(versions.deletedAt)))
      .orderBy(desc(versions.n))
      .limit(1);
    const [frameRows, blockRows, then] = await Promise.all([
      db.select().from(frames).where(eq(frames.versionId, version.id)),
      db.select().from(blocks).where(eq(blocks.versionId, version.id)),
      previous ? hashesOf(db, previous.id) : null,
    ]);
    const pageRows = await db
      .select()
      .from(pages)
      .where(eq(pages.versionId, version.id))
      .orderBy(pages.position);

    return etagJson(c, {
      n: version.n,
      // The version this one is compared with: the one before it that isn't deleted.
      previous: previous?.n ?? null,
      notes: version.notes,
      message: version.message,
      pages: pageRows.map((page) => {
        const { meta } = page;
        const base = { key: page.pageKey, title: page.title, group: page.group };
        if (page.kind === "article") {
          return {
            ...base,
            kind: page.kind,
            htmlHash: meta.htmlHash,
            outline: meta.outline,
            readingMinutes: meta.readingMinutes,
            theme: meta.theme ?? null,
            blocks: blockRows
              .filter((block) => block.pageKey === page.pageKey)
              .map((block) => ({
                key: block.blockKey,
                contentHash: block.contentHash,
                changed: changedSince(then?.blocks, keyOf(page.pageKey, block.blockKey), block.contentHash),
              })),
          };
        }
        return {
          ...base,
          kind: page.kind,
          boards: meta.boards ?? [],
          meta,
          frames: frameRows
            .filter((frame) => frame.pageKey === page.pageKey)
            // Board order, then reading order: N and P, and "5 of 6", follow this.
            .sort(
              (a, b) => boardIndex(meta, a.boardKey) - boardIndex(meta, b.boardKey) || a.y - b.y || a.x - b.x,
            )
            .map((frame) => ({
              key: frame.frameKey,
              board: frame.boardKey,
              title: frame.title,
              device: frame.device,
              x: frame.x,
              y: frame.y,
              w: frame.w,
              h: frame.h,
              contentHash: frame.contentHash,
              renders: frame.renders,
              live: frame.livePath !== null,
              livePath: frame.livePath,
              changed: changedSince(then?.frames, keyOf(page.pageKey, frame.frameKey), frame.contentHash),
            })),
        };
      }),
    } satisfies VersionDetail);
  });
}
