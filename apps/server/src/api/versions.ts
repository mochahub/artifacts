import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { blocks, decisions, frames, pages, people, versions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { etagJson } from "../http/etag.ts";
import { artifactParam } from "./artifacts-db.ts";
import type { Deps } from "./deps.ts";
import type { Routes } from "./routes.ts";

const boardIndex = (meta: Record<string, unknown>, key: string) =>
  ((meta.boards ?? []) as { key: string }[]).findIndex((board) => board.key === key);

export function versionRoutes(routes: Routes, deps: Deps) {
  const { db } = deps;
  const artifact = artifactParam(deps);

  async function hashes(versionId: string) {
    const [frameRows, blockRows] = await Promise.all([
      db.select().from(frames).where(eq(frames.versionId, versionId)),
      db.select().from(blocks).where(eq(blocks.versionId, versionId)),
    ]);
    return { frameRows, blockRows };
  }
  const changeSet = (before: Map<string, string>, after: Map<string, string>) => ({
    added: [...after.keys()].filter((key) => !before.has(key)),
    removed: [...before.keys()].filter((key) => !after.has(key)),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)),
  });

  routes.get("/api/artifacts/:id/versions", { action: "artifact.read", resource: artifact }, async (c) => {
    const id = c.req.param("id") as string;
    const [rows, decided] = await Promise.all([
      db
        .select({ version: versions, by: people.name })
        .from(versions)
        .innerJoin(people, eq(people.id, versions.publishedBy))
        .where(and(eq(versions.artifactId, id), isNull(versions.deletedAt)))
        .orderBy(desc(versions.n)),
      db.select().from(decisions).where(eq(decisions.artifactId, id)).orderBy(desc(decisions.createdAt)),
    ]);
    const counts = await Promise.all(
      rows.map(async ({ version }, index) => {
        const previous = rows[index + 1]?.version;
        if (!previous) return { frames: 0, blocks: 0 };
        const [now, then] = await Promise.all([hashes(version.id), hashes(previous.id)]);
        const map = (list: { key: string; hash: string }[]) => new Map(list.map((e) => [e.key, e.hash]));
        const f = (list: typeof now.frameRows) =>
          map(list.map((e) => ({ key: `${e.pageKey}/${e.frameKey}`, hash: e.contentHash })));
        const b = (list: typeof now.blockRows) =>
          map(list.map((e) => ({ key: `${e.pageKey}/${e.blockKey}`, hash: e.contentHash })));
        const fc = changeSet(f(then.frameRows), f(now.frameRows));
        const bc = changeSet(b(then.blockRows), b(now.blockRows));
        return {
          frames: fc.added.length + fc.removed.length + fc.changed.length,
          blocks: bc.added.length + bc.removed.length + bc.changed.length,
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
        agent: version.agent,
        publishedAt: version.publishedAt.toISOString(),
        restoredFrom: version.restoredFrom,
        decision: decided.find((entry) => entry.version === version.n)?.kind,
        changes: counts[index],
      })),
    );
  });

  routes.get("/api/artifacts/:id/versions/:n", { action: "artifact.read", resource: artifact }, async (c) => {
    const id = c.req.param("id") as string;
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
      .select({ id: versions.id })
      .from(versions)
      .where(and(eq(versions.artifactId, id), lt(versions.n, n), isNull(versions.deletedAt)))
      .orderBy(desc(versions.n))
      .limit(1);
    const now = await hashes(version.id);
    const then = previous ? await hashes(previous.id) : { frameRows: [], blockRows: [] };
    const frameBefore = new Map(then.frameRows.map((f) => [`${f.pageKey}/${f.frameKey}`, f.contentHash]));
    const blockBefore = new Map(then.blockRows.map((b) => [`${b.pageKey}/${b.blockKey}`, b.contentHash]));
    const pageRows = await db
      .select()
      .from(pages)
      .where(eq(pages.versionId, version.id))
      .orderBy(pages.position);

    return etagJson(c, {
      n: version.n,
      notes: version.notes,
      message: version.message,
      pages: pageRows.map((page) => {
        const meta = page.meta as Record<string, unknown>;
        const base = { key: page.pageKey, kind: page.kind, title: page.title, group: page.group };
        if (page.kind === "article") {
          return {
            ...base,
            htmlHash: meta.htmlHash,
            outline: meta.outline,
            readingMinutes: meta.readingMinutes,
            blocks: now.blockRows
              .filter((block) => block.pageKey === page.pageKey)
              .map((block) => {
                const old = blockBefore.get(`${page.pageKey}/${block.blockKey}`);
                return {
                  key: block.blockKey,
                  contentHash: block.contentHash,
                  changed: previous !== undefined && old !== block.contentHash,
                };
              }),
          };
        }
        return {
          ...base,
          boards: meta.boards ?? [],
          meta,
          frames: now.frameRows
            .filter((frame) => frame.pageKey === page.pageKey)
            // Board order, then reading order: N and P, and "5 of 6", follow this.
            .sort(
              (a, b) => boardIndex(meta, a.boardKey) - boardIndex(meta, b.boardKey) || a.y - b.y || a.x - b.x,
            )
            .map((frame) => {
              const old = frameBefore.get(`${page.pageKey}/${frame.frameKey}`);
              return {
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
                changed: previous !== undefined && old !== frame.contentHash,
              };
            }),
        };
      }),
    });
  });
}
