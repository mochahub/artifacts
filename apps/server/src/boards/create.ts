import { MANIFEST, type PublishResult } from "@artifacts/schema";
import type { BoardCreateRequest } from "@artifacts/schema/boards";
import type { Asker } from "../auth/caller.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { putBlob } from "../publish/blobs.ts";
import type { Publisher } from "../publish/publisher.ts";

/** The one page of a native-only board (14, "Native-only board creation"). */
export const NATIVE_PAGE = "board";

/**
 * `POST /api/boards` and `artifacts_board_create`: a normal one-canvas wiki page whose first version is an
 * empty schema-1 native board, through the ordinary publish pipeline and its rules. No HTML, no
 * screenshot, no server browser. The `native: 1` marker and `__boards/board.json` are the server's.
 */
export async function createBoard(
  deps: Deps,
  publisher: Publisher,
  asker: Asker,
  request: BoardCreateRequest,
  agent: string | null,
): Promise<PublishResult> {
  // The same permission check prepare and commit run, before anything is stored.
  const { row, project } = await publisher.target(asker, request.project, request.slug);
  if (!project || project.kind !== "wiki")
    throw new ApiError("invalid", "A board is a wiki page: name a wiki you can publish to.");
  if (row)
    throw new ApiError("conflict", "That page already exists. Pick another slug.", { reason: "exists" });
  const page = {
    id: NATIVE_PAGE,
    kind: "canvas",
    native: 1,
    title: request.title,
    boards: [],
    styles: [],
    scripts: [],
  };
  const wiki = { role: "page" as const, sources: request.sources ?? [] };
  const manifest = JSON.stringify(
    {
      project: request.project,
      slug: request.slug,
      title: request.title,
      wiki,
      summary: request.summary,
      ...(request.tags ? { tags: request.tags } : {}),
      pages: [page],
    },
    null,
    2,
  );
  const bytes = new TextEncoder().encode(manifest);
  const hash = await putBlob(deps, asker.org.id, bytes, "application/json");
  const prepared = await publisher.prepare(asker, {
    project: request.project,
    slug: request.slug,
    title: request.title,
    files: [{ path: MANIFEST, sha256: hash, size: bytes.length, type: "application/json" }],
  });
  return publisher.commit(
    asker,
    {
      uploadId: prepared.uploadId,
      message: null,
      name: null,
      summary: request.summary,
      tags: request.tags ?? null,
      wiki,
      notes: {},
      agent,
      files: { [MANIFEST]: { hash, size: bytes.length, type: "application/json" } },
      backendHash: null,
      pages: [
        {
          key: NATIVE_PAGE,
          kind: "canvas",
          title: request.title,
          group: null,
          position: 0,
          meta: { boards: [] },
        },
      ],
      frames: [],
      blocks: [],
    },
    null,
    { nativeBoard: NATIVE_PAGE },
  );
}
