import { type BlockRecord, MANIFEST, type VersionFiles } from "@artifacts/schema";
import { articleBlockCount, buildArticle } from "@artifacts/schema/article";
import { and, asc, eq } from "drizzle-orm";
import { blocks, pages, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { blobKey } from "../layout.ts";
import { mintBlockId } from "./model.ts";

const THRESHOLD = 0.6;

/** How much of `wanted` the start and end of `actual` keep, as re-anchoring scores a quote (05). */
function similarity(wanted: string, actual: string) {
  if (!wanted) return actual ? 0 : 1;
  const count = Math.min(wanted.length, actual.length);
  let start = 0;
  while (start < count && wanted[start] === actual[start]) start += 1;
  let end = 0;
  while (end < count - start && wanted.at(-1 - end) === actual.at(-1 - end)) end += 1;
  return (Math.min(1, (start + end) / wanted.length) + start / wanted.length + end / wanted.length) / 3;
}

async function blobText(deps: Deps, hash: string | undefined) {
  if (!hash) return null;
  const object = await deps.bucket.get(blobKey(hash));
  return object ? new TextDecoder().decode(object.body) : null;
}

/**
 * The carry-over in 13, "Ids in versions": a CLI or MCP publish (Markdown with no ids) onto a page whose
 * previous version has lasting ids keeps them where it can. Each new block takes the id of the first
 * unused previous block with an equal content hash, else the best quote-similar one (0.6 or more), else
 * a new id. The clean HTML's `data-block` and the blocks rows are rewritten to match. Null when the page
 * had no ids, or the blocks can't be paired with the Markdown, which leaves the publish as it was.
 */
export async function carryIds(
  deps: Deps,
  input: {
    artifactId: string;
    latestVersion: number;
    pageKey: string;
    project: string;
    files: VersionFiles;
    html: string;
    blocks: BlockRecord[];
  },
): Promise<{ html: string; blocks: BlockRecord[]; blockIds: string[] } | null> {
  if (input.latestVersion < 1) return null;
  const [previous] = await deps.db
    .select({ id: versions.id, meta: pages.meta })
    .from(versions)
    .innerJoin(pages, and(eq(pages.versionId, versions.id), eq(pages.pageKey, input.pageKey)))
    .where(and(eq(versions.artifactId, input.artifactId), eq(versions.n, input.latestVersion)))
    .limit(1);
  if (!previous?.meta.blockIds?.length) return null;
  const manifest = JSON.parse((await blobText(deps, input.files[MANIFEST]?.hash)) ?? "{}") as {
    pages?: { id: string; src?: string }[];
  };
  const src = manifest.pages?.find((page) => page.id === input.pageKey)?.src;
  const source = src ? await blobText(deps, input.files[src]?.hash) : null;
  if (!src || source === null) return null;

  const minted = Array.from({ length: articleBlockCount(source) }, () => mintBlockId());
  // The same pipeline with placeholder ids says which group each of the client's elements is.
  const built = buildArticle({
    source,
    path: src,
    project: input.project,
    blockIds: minted,
    readFile: () => "",
    blobHash: (path) => input.files[path]?.hash,
    frameHash: () => undefined,
    mermaid: new Map(),
  });
  if (built.blocks.length !== input.blocks.length) return null;

  const before = await deps.db
    .select({ key: blocks.blockKey, hash: blocks.contentHash, text: blocks.text })
    .from(blocks)
    .where(and(eq(blocks.versionId, previous.id), eq(blocks.pageKey, input.pageKey)))
    .orderBy(asc(blocks.id))
    .limit(5000);
  const lasting = new Set(previous.meta.blockIds);
  const candidates = before.filter((row) => lasting.has(row.key));
  const used = new Set<string>();
  const ids = [...minted];
  const groupOf = new Map(minted.map((id, index) => [id, index]));
  input.blocks.forEach((block, j) => {
    const group = groupOf.get((built.blocks[j] as { blockKey: string }).blockKey);
    if (group === undefined) return;
    const same = candidates.find((row) => !used.has(row.key) && row.hash === block.contentHash);
    let pick = same?.key;
    if (!pick) {
      let best: { key: string; score: number } | null = null;
      for (const row of candidates) {
        if (used.has(row.key)) continue;
        const score = similarity(row.text, block.text);
        if (score >= THRESHOLD && (!best || score > best.score)) best = { key: row.key, score };
      }
      pick = best?.key;
    }
    if (pick) {
      used.add(pick);
      ids[group] = pick;
    }
  });

  const final = new Map(minted.map((id, index) => [id, ids[index] as string]));
  const keyFor = (key: string) => {
    const [head, tail] = key.split("/");
    const id = final.get(head as string) ?? head;
    return tail ? `${id}/${tail}` : (id as string);
  };
  const renamed = new Map(
    input.blocks.map((block, j) => [
      block.blockKey,
      keyFor((built.blocks[j] as { blockKey: string }).blockKey),
    ]),
  );
  const html = input.html.replace(/data-block="([^"]*)"/g, (whole, key: string) =>
    renamed.has(key) ? `data-block="${renamed.get(key)}"` : whole,
  );
  return {
    html,
    blocks: input.blocks.map((block) => ({
      ...block,
      blockKey: renamed.get(block.blockKey) ?? block.blockKey,
    })),
    blockIds: ids,
  };
}
