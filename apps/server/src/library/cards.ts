import { type LibraryCard, type LibraryMatch, SUMMARY_MAX } from "@artifacts/schema";
import { desc, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Deps } from "../api/deps.ts";
import { buildCards } from "../api/lists.ts";
import type { Caller } from "../auth/caller.ts";
import { blocks, decisions, frames, versions } from "../db/schema.ts";
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
