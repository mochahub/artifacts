import {
  AcceptSuggestion,
  type Attribution,
  Checkpoint,
  type DocState,
  type DraftView,
  EditRequest,
  FinishRun,
  MANIFEST,
  type Presence,
  RejectSuggestion,
  SetMaintained,
  StartRun,
  SuggestionStatus,
} from "@artifacts/schema";
import { buildArticle } from "@artifacts/schema/article";
import { sanitizeArticle } from "@artifacts/schema/sanitize";
import { and, eq, inArray, sql } from "drizzle-orm";
import { findArtifact, type LoadedArtifact, toProject } from "../auth/access.ts";
import { actorOf, agentOf, type Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { boardRoutes } from "../boards/routes.ts";
import {
  activity,
  artifacts,
  blocks,
  editAtoms,
  editDocs,
  editRuns,
  people,
  suggestions,
  tokens,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import { artifactParam } from "../http/resources.ts";
import type { ApiContext, Routes } from "../http/routes.ts";
import { blobKey } from "../layout.ts";
import { wikiAudience } from "../wiki/service.ts";
import { checkpoint } from "./checkpoint.ts";
import { authorRuns, docToMarkdown, yToDoc } from "./model.ts";
import { applyOps, pageRead } from "./ops.ts";
import { agentPolicy, freshPresence, missingEditScope } from "./policy.ts";
import {
  acceptRun,
  activeRuns,
  cancelRun,
  documentContext,
  findRun,
  finishRun,
  type RunRow,
  rejectRun,
  startRun,
  toRuns,
} from "./runs.ts";
import { editability, ensureDoc, loadDoc } from "./store.ts";
import {
  applySuggestion,
  authoredBy,
  authorsFor,
  decide,
  listSuggestions,
  logDecision,
  type SuggestionRow,
  visibleSources,
} from "./suggestions.ts";

type PmNode = { type: string; attrs?: Record<string, unknown>; content?: PmNode[] };

const notEditable = (reason: string) =>
  new ApiError("conflict", "This page can't be edited here.", { reason: "not_editable", editable: reason });
/** Article-only routes refuse a board draft with `not_article` (14, "Sync and holds"). */
const isBoard = (state: object) => (state as { kind?: string }).kind === "board";

async function blobText(deps: Deps, hash: string | undefined) {
  if (!hash) return null;
  const object = await deps.bucket.get(blobKey(hash));
  return object ? new TextDecoder().decode(object.body) : null;
}

/** `GET …/doc`. Someone who can't edit learns only what readers know: nobody is told someone is editing. */
export async function docState(deps: Deps, caller: Caller, artifact: LoadedArtifact): Promise<DocState> {
  const state = await editability(deps, artifact);
  const canEdit = can(caller, "artifact.edit", artifact);
  const base = {
    editable: state.editable,
    reason: state.editable ? null : state.reason,
    canEdit,
    canAccept: can(caller, "artifact.accept", artifact),
    canMaintain: can(caller, "artifact.maintain", artifact),
    version: artifact.row.latestVersion,
    agentMaintained: artifact.row.agentMaintained,
  };
  if (!canEdit) {
    return {
      ...base,
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
    activeRuns(deps, artifact.id),
    deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(suggestions)
      .where(and(eq(suggestions.artifactId, artifact.id), eq(suggestions.status, "open"))),
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
        ).map((person) => [person.id, person.name])
      : [],
  );
  const people_: Presence[] = present.map((entry) => ({
    kind: "person",
    name: names.get(entry.personId) ?? "Someone",
    for: null,
    mode: entry.mode,
    block: entry.blocks[0] ?? null,
    run: null,
  }));
  // `for` is the person's name (`Run.startedBy` is already one), and null for an organization token's run.
  const byOrgToken = new Set(
    runs.length
      ? (
          await deps.db
            .select({ id: editRuns.id })
            .from(editRuns)
            .innerJoin(tokens, eq(tokens.id, editRuns.tokenId))
            .where(
              and(
                inArray(
                  editRuns.id,
                  runs.map((run) => run.id),
                ),
                eq(tokens.kind, "org"),
              ),
            )
        ).map((run) => run.id)
      : [],
  );
  const agents: Presence[] = runs.map((run) => ({
    kind: "agent",
    name: run.agent ?? "agent",
    for: byOrgToken.has(run.id) ? null : run.startedBy,
    mode: null,
    block: null,
    run: run.id,
  }));
  const live = row && row.snapshot.length > 0 ? row : null;
  return {
    ...base,
    dirty: live
      ? live.seq !== live.checkpointSeq || Object.keys(live.meta ?? {}).some((key) => key !== "sweep")
      : false,
    seq: row?.seq ?? 0,
    epoch: row?.epoch ?? 0,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    audience: audience.audience,
    agents: { edits: policy.edits, reason: policy.reason, text: policy.text },
    present: [...people_, ...agents],
    openSuggestions: open?.n ?? 0,
    runs,
  };
}

/** The draft drawn by the server, sanitized: the checkpoint pipeline's resolvers, without making one. */
async function draftView(deps: Deps, artifact: LoadedArtifact): Promise<DraftView> {
  const state = await editability(deps, artifact);
  if (!state.editable) throw notEditable(state.reason);
  if (isBoard(state)) throw notEditable("not_article");
  await ensureDoc(deps, artifact);
  const { ydoc, row } = await loadDoc(deps, artifact.id);
  const atoms = await deps.db
    .select({ hash: editAtoms.hash, source: editAtoms.source, svg: editAtoms.svg })
    .from(editAtoms)
    .where(eq(editAtoms.artifactId, artifact.id));
  const sources = new Map(atoms.map((atom) => [atom.hash, atom.source]));
  const { markdown, blockIds } = docToMarkdown(yToDoc(ydoc), (hash) => sources.get(hash) ?? "");
  const [base] = await deps.db
    .select({ files: versions.files })
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, artifact.row.latestVersion)))
    .limit(1);
  // Relative image paths resolve against the page's own source file, as at checkpoint.
  const manifest = JSON.parse((await blobText(deps, base?.files[MANIFEST]?.hash)) ?? "{}") as {
    pages?: { id: string; src?: string }[];
  };
  const src = manifest.pages?.find((entry) => entry.id === state.pageKey)?.src ?? "doc.md";
  const built = buildArticle({
    source: markdown,
    path: src,
    project: artifact.project.slug,
    blockIds,
    mermaid: new Map(atoms.flatMap((atom) => (atom.svg ? [[atom.source, atom.svg] as const] : []))),
    readFile: () => "",
    blobHash: (path) => base?.files[path]?.hash,
    frameHash: () => undefined,
  });
  return {
    html: sanitizeArticle(built.html),
    blockIds,
    outline: built.outline,
    version: artifact.row.latestVersion,
    seq: row.seq,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/** `GET …/authors`: who wrote which passage, of a version or of the draft. Hidden sources are left out. */
async function attribution(
  deps: Deps,
  caller: Caller,
  artifact: LoadedArtifact,
  query: { version?: number; draft: boolean },
): Promise<Attribution> {
  const sources = await visibleSources(deps, caller, artifact);
  const runs: Attribution["blocks"] = {};
  if (query.draft) {
    const { ydoc } = await loadDoc(deps, artifact.id);
    for (const node of (yToDoc(ydoc) as PmNode).content ?? []) {
      const id = String(node.attrs?.id ?? "");
      const found = authorRuns(node as never);
      if (id && found.length)
        runs[id] = found.map((run) => ({ ...run, t: new Date(run.t * 60_000).toISOString() }));
    }
  } else {
    const n = query.version ?? artifact.row.latestVersion;
    const rows = await deps.db
      .select({ key: blocks.blockKey, authors: blocks.authors })
      .from(blocks)
      .innerJoin(versions, eq(versions.id, blocks.versionId))
      .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, n)))
      .limit(5000);
    for (const row of rows) if (row.authors?.length) runs[row.key] = row.authors;
  }
  const keys = [...new Set(Object.values(runs).flatMap((list) => list.map((run) => run.a)))];
  return {
    version: query.draft ? null : (query.version ?? artifact.row.latestVersion),
    draft: query.draft,
    authors: await authorsFor(deps, artifact.id, keys, sources),
    blocks: runs,
  };
}

const yamlValue = (value: unknown) => JSON.stringify(value ?? null);

/** `GET …/export.md`: front matter, then the body with atoms exact and `[[links]]` as written. */
async function exportMarkdown(
  deps: Deps,
  artifact: LoadedArtifact,
  query: { version?: number; draft: boolean },
) {
  const n = query.version ?? artifact.row.latestVersion;
  const [version] = await deps.db
    .select()
    .from(versions)
    .where(and(eq(versions.artifactId, artifact.id), eq(versions.n, n)))
    .limit(1);
  if (!version || version.deletedAt) throw new ApiError("not_found", "No such version.");
  const manifest = JSON.parse((await blobText(deps, version.files[MANIFEST]?.hash)) ?? "{}") as {
    title?: string;
    pages?: { id: string; kind: string; src?: string }[];
  };
  let body: string;
  let meta: { title?: string; summary?: string; tags?: string[]; sources?: string[] } = {};
  if (query.draft) {
    const { ydoc, row } = await loadDoc(deps, artifact.id);
    const atoms = await deps.db
      .select({ hash: editAtoms.hash, source: editAtoms.source })
      .from(editAtoms)
      .where(eq(editAtoms.artifactId, artifact.id));
    const sources = new Map(atoms.map((atom) => [atom.hash, atom.source]));
    body = docToMarkdown(yToDoc(ydoc), (hash) => sources.get(hash) ?? "").markdown;
    meta = row.meta ?? {};
  } else {
    const page = manifest.pages?.find((entry) => entry.kind === "article");
    const text = page?.src ? await blobText(deps, version.files[page.src]?.hash) : null;
    if (text === null)
      throw new ApiError("conflict", "This version has no article to export.", { reason: "not_editable" });
    body = text;
  }
  const front = [
    `title: ${yamlValue(meta.title ?? manifest.title ?? artifact.row.title)}`,
    `version: ${n}`,
    `draft: ${query.draft}`,
    `summary: ${yamlValue(meta.summary ?? version.summary)}`,
    `tags: ${yamlValue(meta.tags ?? version.tags ?? [])}`,
    `role: ${yamlValue(version.wiki?.role ?? null)}`,
    `sources: ${yamlValue(meta.sources ?? version.wiki?.sources ?? [])}`,
    `origin: ${yamlValue(version.wiki?.origin ?? null)}`,
    `untrusted: ${yamlValue(version.wiki?.untrusted ?? false)}`,
  ];
  return `---\n${front.join("\n")}\n---\n\n${body}`;
}

/** `:id` of a suggestion or a run: the artifact it's on, loaded and checked like any artifact route. */
function suggestionParam(deps: Deps) {
  return async function load(c: ApiContext): Promise<LoadedArtifact & { suggestion: SuggestionRow }> {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await deps.db
          .select()
          .from(suggestions)
          .where(and(eq(suggestions.orgId, c.get("org").id), eq(suggestions.id, id)))
          .limit(1)
      : [];
    const artifact = row ? await findArtifact(deps, row.orgId, row.artifactId) : null;
    if (!row || !artifact) throw new ApiError("not_found", "Not found.");
    return { ...artifact, suggestion: row };
  };
}
function runParam(deps: Deps) {
  return async function load(c: ApiContext): Promise<LoadedArtifact & { run: RunRow }> {
    const id = c.req.param("id");
    const row = isUuid(id) ? await findRun(deps, c.get("org").id, id) : null;
    const artifact = row ? await findArtifact(deps, row.orgId, row.artifactId) : null;
    if (!row || !artifact) throw new ApiError("not_found", "Not found.");
    return { ...artifact, run: row };
  };
}

const numberQuery = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new ApiError("invalid", "version must be a positive whole number.");
  return n;
};
const draftQuery = (value: string | undefined) => value === "1" || value === "true";
const requireEdit = (caller: Caller, artifact: LoadedArtifact) => {
  if (!can(caller, "artifact.edit", artifact))
    throw new ApiError(
      "forbidden",
      missingEditScope(caller, artifact)
        ? "Run artifacts login again or reconnect the Artifacts connector to edit pages."
        : "Reading the draft needs the edit right.",
      missingEditScope(caller, artifact) ? { scope: "edit" } : {},
    );
};

/** The editing routes in 13, "HTTP API". The sync socket is the realtime layer's. */
export function editingRoutes(routes: Routes, deps: Deps) {
  const artifact = artifactParam(deps);
  const suggestion = suggestionParam(deps);
  const run = runParam(deps);
  // Board routes are registered here too, so the one API keeps one list of handlers (14).
  boardRoutes(routes, deps);

  routes.get("/api/artifacts/:id/doc", { action: "artifact.read", resource: artifact }, async (c) =>
    c.json(await docState(deps, c.var.caller, c.var.resource)),
  );
  routes.get("/api/artifacts/:id/doc/draft", { action: "artifact.edit", resource: artifact }, async (c) =>
    c.json(await draftView(deps, c.var.resource)),
  );
  routes.get(
    "/api/artifacts/:id/doc/markdown",
    { action: "artifact.read", resource: artifact },
    async (c) => {
      const draft = draftQuery(c.req.query("draft"));
      if (draft) requireEdit(c.var.caller, c.var.resource);
      return c.json(
        await pageRead(deps, c.var.caller, c.var.resource, { draft, cursor: c.req.query("cursor") }),
      );
    },
  );
  routes.post(
    "/api/artifacts/:id/doc/ops",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => c.json(await applyOps(deps, c.var.caller, c.var.resource, await parseBody(c, EditRequest))),
  );
  routes.post(
    "/api/artifacts/:id/doc/checkpoint",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      const body = await parseBody(c, Checkpoint);
      const state = await editability(deps, c.var.resource);
      if (!state.editable) throw notEditable(state.reason);
      if (isBoard(state)) throw notEditable("not_article");
      const { caller } = c.var;
      return c.json(
        await checkpoint(deps, c.var.resource.id, {
          kind: caller.kind === "person" ? "saved" : "agent",
          personId: actorOf(caller),
          agent: agentOf(caller, null),
          name: body.name ?? null,
          message: body.message ?? null,
        }),
      );
    },
  );
  routes.put(
    "/api/artifacts/:id/doc/maintained",
    { action: "artifact.maintain", resource: artifact, writes: true },
    async (c) => {
      const { agentMaintained } = await parseBody(c, SetMaintained);
      const { resource, caller } = c.var;
      const now = deps.clock.now();
      if (resource.row.agentMaintained !== agentMaintained) {
        const context = await documentContext(deps, resource);
        await deps.db.transaction(async (tx) => {
          await tx
            .update(artifacts)
            .set({ agentMaintained, agentMaintainedBy: caller.person.id, agentMaintainedAt: now })
            .where(eq(artifacts.id, resource.id));
          await tx.insert(activity).values({
            id: Bun.randomUUIDv7(),
            orgId: resource.row.orgId,
            artifactId: resource.id,
            projectId: resource.projectId,
            actorPersonId: caller.person.id,
            agent: null,
            kind: "maintained_changed",
            payload: { agentMaintained, ...context },
            createdAt: now,
          });
        });
      }
      const fresh = (await findArtifact(deps, resource.row.orgId, resource.id)) as LoadedArtifact;
      return c.json(await docState(deps, caller, fresh));
    },
  );

  routes.get("/api/artifacts/:id/suggestions", { action: "artifact.edit", resource: artifact }, async (c) => {
    const status = c.req.query("status");
    const parsed = status ? SuggestionStatus.safeParse(status) : null;
    if (parsed && !parsed.success)
      throw new ApiError("invalid", "status isn't one of the suggestion statuses.");
    const runId = c.req.query("run");
    if (runId && !isUuid(runId)) throw new ApiError("invalid", "run isn't valid.");
    const cursor = c.req.query("cursor");
    if (cursor && !isUuid(cursor)) throw new ApiError("invalid", "That cursor isn't valid.");
    return c.json(
      await listSuggestions(deps, c.var.caller, c.var.resource, {
        status: parsed?.data,
        run: runId,
        cursor,
      }),
    );
  });
  routes.post(
    "/api/suggestions/:id/accept",
    { action: "artifact.accept", resource: suggestion, writes: true },
    async (c) => {
      const { force } = await parseBody(c, AcceptSuggestion);
      const { resource, caller } = c.var;
      const result = await applySuggestion(deps, caller, resource, resource.suggestion, force ?? false);
      await logDecision(deps, resource, caller.person.id, "suggestion_accepted", {
        suggestion: resource.suggestion.id,
        count: 1,
      });
      deps.docs?.notify(resource.id, "c", {
        t: "suggestion",
        id: resource.suggestion.id,
        status: "accepted",
      });
      return c.json(result);
    },
  );
  routes.post(
    "/api/suggestions/:id/reject",
    { action: "artifact.accept", resource: suggestion, writes: true },
    async (c) => {
      const { note } = await parseBody(c, RejectSuggestion);
      const { resource, caller } = c.var;
      await decide(deps, resource.suggestion, "rejected", caller.person.id, note);
      await logDecision(deps, resource, caller.person.id, "suggestion_rejected", {
        suggestion: resource.suggestion.id,
        count: 1,
      });
      deps.docs?.notify(resource.id, "c", {
        t: "suggestion",
        id: resource.suggestion.id,
        status: "rejected",
      });
      return c.json({ status: "rejected" as const, seq: await seqOf(deps, resource.id) });
    },
  );
  routes.post(
    "/api/suggestions/:id/withdraw",
    { action: "artifact.edit", resource: suggestion, writes: true },
    async (c) => {
      const { resource, caller } = c.var;
      if (!authoredBy(caller, resource.suggestion)) {
        throw new ApiError("forbidden", "Only the suggestion's author withdraws it.");
      }
      await decide(
        deps,
        resource.suggestion,
        "withdrawn",
        caller.kind === "person" ? caller.person.id : null,
      );
      deps.docs?.notify(resource.id, "c", {
        t: "suggestion",
        id: resource.suggestion.id,
        status: "withdrawn",
      });
      return c.json({ status: "withdrawn" as const, seq: await seqOf(deps, resource.id) });
    },
  );

  routes.post(
    "/api/artifacts/:id/doc/runs",
    { action: "artifact.edit", resource: artifact, writes: true },
    async (c) => {
      const body = await parseBody(c, StartRun);
      const state = await editability(deps, c.var.resource);
      if (!state.editable) throw notEditable(state.reason);
      return c.json(await startRun(deps, c.var.caller, c.var.resource, body), 201);
    },
  );
  routes.post("/api/runs/:id/finish", { action: "artifact.edit", resource: run, writes: true }, async (c) => {
    const { message } = await parseBody(c, FinishRun);
    return c.json(await finishRun(deps, c.var.caller, c.var.resource, c.var.resource.run, message));
  });
  routes.post("/api/runs/:id/cancel", { action: "artifact.edit", resource: run, writes: true }, async (c) =>
    c.json(await cancelRun(deps, c.var.caller, c.var.resource, c.var.resource.run)),
  );
  routes.post(
    "/api/runs/:id/accept",
    { action: "artifact.accept", resource: run, writes: true },
    async (c) => {
      const { force } = await parseBody(c, AcceptSuggestion);
      return c.json(await acceptRun(deps, c.var.caller, c.var.resource, c.var.resource.run, force ?? false));
    },
  );
  routes.post(
    "/api/runs/:id/reject",
    { action: "artifact.accept", resource: run, writes: true },
    async (c) => {
      const { note } = await parseBody(c, RejectSuggestion);
      return c.json(await rejectRun(deps, c.var.caller, c.var.resource, c.var.resource.run, note));
    },
  );

  routes.get("/api/artifacts/:id/authors", { action: "artifact.read", resource: artifact }, async (c) => {
    const draft = draftQuery(c.req.query("draft"));
    if (draft) requireEdit(c.var.caller, c.var.resource);
    return c.json(
      await attribution(deps, c.var.caller, c.var.resource, {
        draft,
        version: numberQuery(c.req.query("version")),
      }),
    );
  });
  routes.get("/api/artifacts/:id/export.md", { action: "artifact.read", resource: artifact }, async (c) => {
    const draft = draftQuery(c.req.query("draft"));
    if (draft) requireEdit(c.var.caller, c.var.resource);
    const text = await exportMarkdown(deps, c.var.resource, {
      draft,
      version: numberQuery(c.req.query("version")),
    });
    return c.body(text, 200, { "content-type": "text/markdown; charset=utf-8" });
  });
}

async function seqOf(deps: Deps, artifactId: string) {
  const [row] = await deps.db
    .select({ seq: editDocs.seq })
    .from(editDocs)
    .where(eq(editDocs.artifactId, artifactId));
  return row?.seq ?? 0;
}

export { toRuns };
