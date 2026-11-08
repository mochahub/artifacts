import {
  AcceptSuggestion,
  BOARD_CALL_MAX,
  BoardAssetPrepare,
  BoardCaptureCommit,
  BoardCaptureRequest,
  BoardCheckpoint,
  type BoardPresence,
  type BoardState,
  type BoardVersionView,
  SuggestionStatus,
} from "@artifacts/schema";
import { BoardEditRequest } from "@artifacts/schema/boards";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { type LoadedArtifact, toProject } from "../auth/access.ts";
import { actorOf, agentOf, type Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import {
  boardAssets,
  boardSuggestions,
  boardVersions,
  editDocs,
  pages,
  people,
  projects,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { agentPolicy, freshPresence } from "../editing/policy.ts";
import { boardRuns } from "../editing/runs.ts";
import { withDocLock } from "../editing/store.ts";
import { authorsFor, visibleSources } from "../editing/suggestions.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import { artifactParam } from "../http/resources.ts";
import type { Routes } from "../http/routes.ts";
import { blobKey } from "../layout.ts";
import { wikiAudience } from "../wiki/service.ts";
import { commitBoardAssets, prepareBoardAssets } from "./assets.ts";
import { attachThreadCrops, commitCapture, prepareCapture } from "./captures.ts";
import { checkpointBoardLocked } from "./checkpoint.ts";
import { boardEdit } from "./ops.ts";
import { readBoard } from "./read.ts";
import {
  acceptBoardSuggestion,
  boardSuggestionParam,
  decideBoardSuggestion,
  listBoardSuggestions,
  previewBoardSuggestion,
} from "./suggestions.ts";

type Reason = NonNullable<BoardState["reason"]>;
export type BoardEligibility =
  | { editable: true; reason: null; pageKey: string }
  | { editable: false; reason: Reason; pageKey: string | null };

/**
 * Whether the page is an editable board (14, "Concepts and eligibility"): an unarchived wiki page, not a
 * source, whose latest version is exactly one canvas page with no backend. The role check comes first.
 */
export async function boardEligibility(deps: Deps, artifact: LoadedArtifact): Promise<BoardEligibility> {
  if (artifact.project.kind !== "wiki") return { editable: false, reason: "not_wiki", pageKey: null };
  if (artifact.row.archivedAt || artifact.row.deletedAt)
    return { editable: false, reason: "archived", pageKey: null };
  const rows = await deps.db
    .select({ key: pages.pageKey, kind: pages.kind, wiki: versions.wiki })
    .from(pages)
    .innerJoin(versions, eq(versions.id, pages.versionId))
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(2);
  const [page] = rows;
  if (page?.wiki && page.wiki.role !== "page")
    return { editable: false, reason: "not_canvas", pageKey: null };
  if (rows.length !== 1 || page?.kind !== "canvas")
    return { editable: false, reason: "not_canvas", pageKey: null };
  if (artifact.row.hasBackend) return { editable: false, reason: "has_backend", pageKey: page.key };
  return { editable: true, reason: null, pageKey: page.key };
}

const notEditable = (reason: string) =>
  new ApiError("conflict", "This board can't be edited here.", { reason: "not_editable", editable: reason });

/** Board routes refuse an article draft, as article routes refuse a board one (14, "Sync and holds"). */
export async function requireBoard(deps: Deps, artifact: LoadedArtifact) {
  const state = await boardEligibility(deps, artifact);
  if (!state.editable) throw notEditable(state.reason);
  const [row] = await deps.db
    .select({ kind: editDocs.kind })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifact.id))
    .limit(1);
  if (row && row.kind !== "board") throw notEditable("not_canvas");
  return state;
}

/**
 * `GET …/board`. A caller without edit learns only what a reader knows: eligibility, the latest version,
 * and the published agent-maintained setting. No draft, presence, run or suggestion query is made for them.
 */
export async function boardState(deps: Deps, caller: Caller, artifact: LoadedArtifact): Promise<BoardState> {
  const state = await boardEligibility(deps, artifact);
  const canEdit = can(caller, "artifact.edit", artifact);
  const base = {
    editable: state.editable,
    reason: state.reason,
    canEdit,
    version: artifact.row.latestVersion,
    agentMaintained: artifact.row.agentMaintained,
  };
  if (!canEdit) {
    return {
      ...base,
      canAccept: false,
      canMaintain: false,
      dirty: false,
      seq: 0,
      epoch: 0,
      updatedAt: null,
      audience: null,
      agents: null,
      present: [],
      openSuggestions: 0,
      runs: [],
    };
  }
  const [[row], present, runs, [open], audience, policy] = await Promise.all([
    deps.db.select().from(editDocs).where(eq(editDocs.artifactId, artifact.id)).limit(1),
    freshPresence(deps, artifact.id),
    boardRuns(deps, caller, artifact),
    deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(boardSuggestions)
      .where(and(eq(boardSuggestions.artifactId, artifact.id), eq(boardSuggestions.status, "open"))),
    wikiAudience(deps, caller, await toProject(deps, artifact.project)),
    agentPolicy(deps, caller, artifact, { forAgents: true }),
  ]);
  const ids = [...new Set(present.map((entry) => entry.personId))];
  const names = new Map(
    ids.length
      ? (
          await deps.db
            .select({ id: people.id, name: people.name })
            .from(people)
            .where(inArray(people.id, ids))
            .limit(ids.length)
        ).map((person) => [person.id, person.name])
      : [],
  );
  const live = row && row.kind === "board" && row.snapshot.length > 0 ? row : null;
  const presence: z.infer<typeof BoardPresence>[] = [
    ...present.map((entry) => ({
      kind: "person" as const,
      name: names.get(entry.personId) ?? "Someone",
      for: null,
      mode: entry.mode,
      objects: entry.objects.slice(0, 50),
      run: null,
    })),
    ...runs
      .filter((run) => run.status === "active")
      .map((run) => ({
        kind: "agent" as const,
        name: run.agent ?? "agent",
        for: run.startedBy,
        mode: null,
        objects: [],
        run: run.id,
      })),
  ];
  return {
    ...base,
    canAccept: can(caller, "artifact.accept", artifact),
    canMaintain: can(caller, "artifact.maintain", artifact),
    dirty: live
      ? live.seq !== live.checkpointSeq || Object.keys(live.meta ?? {}).some((key) => key !== "sweep")
      : false,
    seq: live?.seq ?? 0,
    epoch: live?.epoch ?? 0,
    updatedAt: live?.updatedAt?.toISOString() ?? null,
    audience: audience.audience,
    agents: { edits: policy.edits, reason: policy.reason, text: policy.text },
    present: presence,
    openSuggestions: open?.n ?? 0,
    runs,
  };
}

/** `GET …/board/snapshot?version=N`: the immutable native scene of a version the caller can read. */
async function versionView(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  n: number | undefined,
): Promise<BoardVersionView> {
  const [found] = await deps.db
    .select({ n: versions.n, deletedAt: versions.deletedAt, board: boardVersions })
    .from(versions)
    .innerJoin(boardVersions, eq(boardVersions.versionId, versions.id))
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, n ?? artifact.row.latestVersion)))
    .limit(1);
  if (!found || found.deletedAt) throw new ApiError("not_found", "No such version.");
  const snapshot = found.board.snapshot;
  const keys = new Set<string>();
  for (const object of snapshot.objects) {
    keys.add(object.attribution.created.a);
    for (const stamp of Object.values(object.attribution.fields)) if (stamp) keys.add(stamp.a);
    for (const run of object.attribution.text) keys.add(run.a);
  }
  for (const entry of snapshot.deleted) keys.add(entry.a);
  const authors = await authorsFor(
    deps,
    artifact.id,
    [...keys],
    await visibleSources(deps, caller, artifact),
  );
  return {
    version: found.n,
    page: found.board.pageKey,
    hash: found.board.hash,
    snapshot,
    authors,
    renders: found.board.renders,
  };
}

const numberQuery = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new ApiError("invalid", "version must be a positive whole number.");
  return n;
};

/** Too big is refused before the body is read (14, "HTTP API"). */
export function refuseOversized(
  c: { req: { header(name: string): string | undefined } },
  max = BOARD_CALL_MAX,
) {
  const length = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(length) || length > max)
    throw new ApiError("too_large", `A board request is at most ${Math.floor(max / 1024)} KiB.`);
}

const sessionPerson = (caller: Caller) => {
  if (caller.kind !== "person")
    throw new ApiError("forbidden", "Only a signed-in browser takes pictures of a board.");
  return caller.person.id;
};

/** May this caller fetch this image? Checkpoint membership for a version; draft/suggestion use for edit. */
async function assetVisible(deps: Deps, caller: Caller, artifact: LoadedArtifact, hash: string, n?: number) {
  if (n !== undefined) {
    const [found] = await deps.db
      .select({
        deletedAt: versions.deletedAt,
        snapshot: boardVersions.snapshot,
        renders: boardVersions.renders,
      })
      .from(versions)
      .innerJoin(boardVersions, eq(boardVersions.versionId, versions.id))
      .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, n)))
      .limit(1);
    if (!found || found.deletedAt) return false;
    const renders = found.renders;
    return (
      found.snapshot.assets.some((image) => image.hash === hash) ||
      renders?.thumbnail.hash === hash ||
      Boolean(renders?.crops.some((crop) => crop.image.hash === hash))
    );
  }
  // Draft or suggestion membership is an editor's: the validated association with this artifact.
  if (!can(caller, "artifact.edit", artifact)) return false;
  const [row] = await deps.db
    .select({ validatedAt: boardAssets.validatedAt })
    .from(boardAssets)
    .where(and(eq(boardAssets.artifactId, artifact.id), eq(boardAssets.hash, hash)))
    .limit(1);
  return Boolean(row?.validatedAt);
}

/** The board routes in 14, "HTTP API", registered with the editing routes. */
export function boardRoutes(routes: Routes, deps: Deps) {
  const artifact = artifactParam(deps);
  const suggestion = boardSuggestionParam(deps);

  routes.get("/api/artifacts/:id/board", { action: "artifact.read", resource: artifact }, async (c) =>
    c.json(await boardState(deps, c.var.caller, c.var.resource)),
  );
  routes.get(
    "/api/artifacts/:id/board/snapshot",
    { action: "artifact.read", resource: artifact },
    async (c) =>
      c.json(await versionView(deps, c.var.caller, c.var.resource, numberQuery(c.req.query("version")))),
  );
  routes.get(
    "/api/artifacts/:id/board/objects",
    { action: "artifact.read", resource: artifact },
    async (c) => {
      const draft = c.req.query("draft");
      const cursor = c.req.query("cursor");
      if (cursor && cursor.length > 400) throw new ApiError("invalid", "That cursor isn't valid.");
      return c.json(
        await readBoard(deps, c.var.caller, c.var.resource, {
          draft: draft === "1" || draft === "true",
          version: numberQuery(c.req.query("version")),
          cursor: cursor || undefined,
        }),
      );
    },
  );
  routes.post(
    "/api/artifacts/:id/board/ops",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      refuseOversized(c);
      const body = await parseBody(c, BoardEditRequest);
      return c.json(await boardEdit(deps, c.var.caller, c.var.resource, body));
    },
  );
  routes.post(
    "/api/artifacts/:id/board/checkpoint",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      refuseOversized(c);
      const body = await parseBody(c, BoardCheckpoint);
      const { caller, resource } = c.var;
      const state = await requireBoard(deps, resource);
      const capture = body.capture ? { ...body.capture, personId: sessionPerson(caller) } : undefined;
      const [project] = await deps.db
        .select()
        .from(projects)
        .where(eq(projects.id, resource.projectId))
        .limit(1);
      if (!project) throw new ApiError("not_found", "Not found.");
      const result = await withDocLock(deps, resource.id, async (lock) => {
        if (!lock.row || lock.row.kind !== "board" || lock.row.pageKey !== state.pageKey)
          return { version: resource.row.latestVersion, created: false, kind: null };
        if (lock.row.epoch !== body.epoch)
          throw new ApiError("conflict", "The draft was reset.", { reason: "stale_epoch" });
        return checkpointBoardLocked(
          deps,
          lock,
          { row: resource.row, project },
          {
            kind: caller.kind === "person" ? "saved" : "agent",
            personId: actorOf(caller),
            agent: agentOf(caller, null),
            name: body.name ?? null,
            message: body.message ?? null,
          },
          capture,
        );
      });
      if (capture && result.created)
        await attachThreadCrops(deps, resource.id, result.version, capture.renders.crops, capture.ticket);
      return c.json(result);
    },
  );

  routes.post(
    "/api/artifacts/:id/board/assets/prepare",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      refuseOversized(c);
      const { images } = await parseBody(c, BoardAssetPrepare);
      await requireBoard(deps, c.var.resource);
      return c.json(await prepareBoardAssets(deps, c.var.caller, c.var.resource, images));
    },
  );
  routes.post(
    "/api/artifacts/:id/board/assets/commit",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      refuseOversized(c);
      const { images } = await parseBody(c, BoardAssetPrepare);
      await requireBoard(deps, c.var.resource);
      return c.json(await commitBoardAssets(deps, c.var.resource, images));
    },
  );
  routes.get(
    "/api/artifacts/:id/board/assets/:hash",
    { action: "artifact.read", resource: artifact },
    async (c) => {
      const hash = c.req.param("hash") ?? "";
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError("not_found", "Not found.");
      const { caller, resource } = c.var;
      // Hidden and missing look alike: a guessed hash from elsewhere learns nothing.
      if (!(await assetVisible(deps, caller, resource, hash, numberQuery(c.req.query("version")))))
        throw new ApiError("not_found", "Not found.");
      return c.redirect(await deps.bucket.presignGet(blobKey(hash)), 302);
    },
  );

  routes.post(
    "/api/artifacts/:id/board/captures",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      const person = sessionPerson(c.var.caller);
      const body = await parseBody(c, BoardCaptureRequest);
      await requireBoard(deps, c.var.resource);
      return c.json(await prepareCapture(deps, person, c.var.resource, body));
    },
  );
  routes.post(
    "/api/artifacts/:id/board/captures/commit",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      const person = sessionPerson(c.var.caller);
      refuseOversized(c);
      const body = await parseBody(c, BoardCaptureCommit);
      const committed = await commitCapture(deps, person, c.var.resource, body);
      await attachThreadCrops(deps, c.var.resource.id, committed.version, body.renders.crops, body.ticket);
      return c.json(committed);
    },
  );

  routes.get(
    "/api/artifacts/:id/board/suggestions",
    { action: "artifact.edit", resource: artifact },
    async (c) => {
      const status = c.req.query("status");
      const parsed = status ? SuggestionStatus.safeParse(status) : null;
      if (parsed && !parsed.success)
        throw new ApiError("invalid", "status isn't one of the suggestion statuses.");
      const cursor = c.req.query("cursor");
      if (cursor && !isUuid(cursor)) throw new ApiError("invalid", "That cursor isn't valid.");
      return c.json(
        await listBoardSuggestions(deps, c.var.caller, c.var.resource, { status: parsed?.data, cursor }),
      );
    },
  );
  routes.get(
    "/api/board-suggestions/:id/preview",
    { action: "artifact.edit", resource: suggestion },
    async (c) => {
      const cursor = c.req.query("cursor");
      if (cursor && cursor.length > 400) throw new ApiError("invalid", "That cursor isn't valid.");
      return c.json(await previewBoardSuggestion(deps, c.var.caller, c.var.resource, cursor || undefined));
    },
  );
  routes.post(
    "/api/board-suggestions/:id/accept",
    { action: "artifact.accept", resource: suggestion, writes: true },
    async (c) => {
      const { force } = await parseBody(c, AcceptSuggestion);
      return c.json(await acceptBoardSuggestion(deps, c.var.caller, c.var.resource, force ?? false));
    },
  );
  routes.post(
    "/api/board-suggestions/:id/reject",
    { action: "artifact.accept", resource: suggestion, writes: true },
    async (c) => {
      const { RejectSuggestion } = await import("@artifacts/schema");
      const { note } = await parseBody(c, RejectSuggestion);
      return c.json(
        await decideBoardSuggestion(deps, c.var.caller, c.var.resource, "rejected", note ?? null),
      );
    },
  );
  routes.post(
    "/api/board-suggestions/:id/withdraw",
    { action: "artifact.edit", resource: suggestion, writes: true },
    async (c) => c.json(await decideBoardSuggestion(deps, c.var.caller, c.var.resource, "withdrawn", null)),
  );
}
