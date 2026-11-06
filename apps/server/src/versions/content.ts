import type { BlockRecord, FrameRecord, PageRecord } from "@artifacts/schema";
import type { Tx } from "../db/index.ts";
import { blocks, frames, pages } from "../db/schema.ts";

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
}

/** Writes a version's pages, frames and blocks: a publish's, or the copy a restore makes. */
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
