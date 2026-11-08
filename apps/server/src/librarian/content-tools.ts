import { and, asc, eq, sql } from "drizzle-orm";
import { findArtifact, findArtifactBySlug, toProject } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import type { Tx } from "../db/index.ts";
import { lockArtifact } from "../db/locks.ts";
import {
  activity,
  artifacts,
  blocks,
  comments,
  librarianConfig,
  librarianProposals,
  pages,
  projects,
  threads,
  tokens,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { applyOps, pageRead } from "../editing/ops.ts";
import { agentPolicy } from "../editing/policy.ts";
import { findRun, finishRun, startRun } from "../editing/runs.ts";
import { docLockIn, ensureDocLocked } from "../editing/store.ts";
import { afterCommit, captureSnapshot, preparation } from "../editing/transaction.ts";
import { ApiError } from "../http/errors.ts";
import { guard, type RunFence } from "./leases.ts";
import type { RunnerIntegration } from "./runner/index.ts";
import { parseTool, schemas } from "./runner/tools.ts";

import { canReadPromotedSource } from "./source-access.ts";

const missing = () => new ApiError("not_found", "Not found.");
/** Transaction adapters. Trusted checkpoint staging precedes the final durable fence check. */
export function createContentTools(deps: Deps): Pick<RunnerIntegration, "authorizeTool" | "tool"> {
  const context = async (tx: Tx, fence: RunFence, wikiId: string) => {
    const run = await guard(deps, tx, fence);
    if (run.wikiId !== wikiId) throw missing();
    const [config] = await tx.select().from(librarianConfig).where(eq(librarianConfig.orgId, fence.orgId));
    const [token] = config?.tokenId
      ? await tx.select().from(tokens).where(eq(tokens.id, config.tokenId))
      : [];
    if (!token?.projectIds?.includes(wikiId)) throw missing();
    const caller: Extract<Caller, { kind: "orgToken" }> = {
      kind: "orgToken",
      tokenId: token.id,
      createdBy: token.createdBy,
      scopes: token.scopes,
      projectIds: token.projectIds,
    };
    const state = preparation.getStore();
    const scoped = {
      ...deps,
      db: tx,
      ...(state
        ? {
            bucket: state.bucket,
            clock: { now: () => state.now },
            limits: {
              hit: (...args: Parameters<Deps["limits"]["hit"]>) => {
                const key = JSON.stringify(args);
                if (!state.limits.has(key)) {
                  deps.limits.hit(...args);
                  state.limits.add(key);
                }
              },
            },
          }
        : {}),
      docs: deps.docs
        ? {
            notify: (...args: Parameters<NonNullable<Deps["docs"]>["notify"]>) =>
              afterCommit(tx, () => deps.docs?.notify(...args)),
            agentPresence: (...args: Parameters<NonNullable<Deps["docs"]>["agentPresence"]>) =>
              afterCommit(tx, () => deps.docs?.agentPresence(...args)),
          }
        : undefined,
      events: {
        ...deps.events,
        emit: (...args: Parameters<Deps["events"]["emit"]>) => {
          afterCommit(tx, () => {
            void deps.events.emit(...args);
          });
          return Promise.resolve();
        },
      },
    } as unknown as Deps;
    const [wiki] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, wikiId), eq(projects.orgId, fence.orgId), eq(projects.kind, "wiki")));
    if (!wiki || !can(caller, "project.read", await toProject(scoped, wiki))) throw missing();
    const page = async (id: string, edit = false) => {
      const slug = id.startsWith(`${wiki.slug}/`) ? id.slice(wiki.slug.length + 1) : id;
      let resource = /^[0-9a-f-]{36}$/i.test(id)
        ? await findArtifact(scoped, fence.orgId, id)
        : !slug.includes("/")
          ? await findArtifactBySlug(scoped, fence.orgId, wiki.slug, slug)
          : null;
      if (resource) {
        await lockArtifact(tx, resource.id, "content");
        resource = await findArtifact(scoped, fence.orgId, resource.id);
      }
      if (
        !resource ||
        resource.projectId !== wikiId ||
        (!can(caller, edit ? "artifact.edit" : "artifact.read", resource) &&
          (edit || !(await canReadPromotedSource(scoped, caller, resource))))
      )
        throw missing();
      captureSnapshot(`artifact:${resource.id}`, resource);
      return resource;
    };
    return { caller, scoped, page };
  };
  const authorizeTool: RunnerIntegration["authorizeTool"] = async (tx, fence, wikiId, name, input) => {
    parseTool(name, input);
    const ctx = await context(tx, fence, wikiId);
    const body = schemas[name].parse(input);
    const ids = new Set<string>();
    if ("page" in body) ids.add(body.page);
    if ("sources" in body) for (const id of body.sources) ids.add(id);
    if (name === "page_edit") {
      const body = schemas.page_edit.parse(input);
      for (const id of body.edit.sources ?? []) ids.add(id);
      for (const op of body.edit.ops) if (op.op === "meta") for (const id of op.sources ?? []) ids.add(id);
    }
    for (const id of [...ids].sort()) await ctx.page(id);
    if ("page" in body && ["page_edit", "page_delegate_start", "page_delegate_finish"].includes(name)) {
      const resource = await ctx.page(body.page, true);
      const policy = await agentPolicy(ctx.scoped, ctx.caller, resource);
      if (policy.edits === "refused") throw missing();
    }
    if (
      name === "question" &&
      "page" in body &&
      !can(ctx.caller, "artifact.comment", await ctx.page(body.page))
    )
      throw missing();
  };
  const tool: RunnerIntegration["tool"] = async (tx, fence, wikiId, name, input, receipt, maxBytes) => {
    await authorizeTool(tx, fence, wikiId, name, input);
    const ctx = await context(tx, fence, wikiId);
    const checkpoint = async (id: string, sourceOnly = false, cursor = 0, expectedVersion?: number) => {
      const resource = await ctx.page(id);
      const [version] = await tx
        .select()
        .from(versions)
        .where(and(eq(versions.artifactId, id), eq(versions.n, resource.row.latestVersion)));
      if (!version || (sourceOnly && version.wiki?.role !== "source")) throw missing();
      if (expectedVersion !== undefined && version.n !== expectedVersion)
        throw new ApiError("conflict", "Checkpoint changed.");
      const rows = await tx
        .select({ id: blocks.blockKey, base: blocks.contentHash, text: blocks.text })
        .from(blocks)
        .where(eq(blocks.versionId, version.id))
        .orderBy(asc(blocks.pageKey), asc(blocks.blockKey));
      if (sourceOnly && rows.length === 0) throw new ApiError("conflict", "Source text unavailable.");
      const sources: string[] = [];
      for (const source of version.wiki?.sources ?? []) {
        try {
          await ctx.page(source);
          sources.push(source);
        } catch {
          /* Hidden citations disclose nothing. */
        }
      }
      // Result budget is bytes; JSON escaping can expand a character up to six bytes.
      const all = rows.flatMap((row) => {
        const chars = [...row.text];
        return Array.from({ length: Math.max(1, Math.ceil(chars.length / 1024)) }, (_, part) => ({
          ...row,
          text: chars.slice(part * 1024, (part + 1) * 1024).join(""),
          part,
        }));
      });
      if (sourceOnly && cursor > all.length) throw new ApiError("invalid", "Invalid source cursor.");
      const selected: typeof all = [];
      if (sourceOnly) {
        for (const row of all.slice(cursor)) {
          if (Buffer.byteLength(JSON.stringify({ blocks: [...selected, row], sources })) > maxBytes - 1000)
            break;
          selected.push(row);
        }
        if (!selected.length && cursor < all.length)
          throw new ApiError("too_large", "Tool result budget too small.");
      }
      return {
        page: id,
        version: version.n,
        title: resource.row.title,
        blocks: sourceOnly ? selected : rows,
        ...(sourceOnly
          ? { nextCursor: cursor + selected.length < all.length ? cursor + selected.length : null }
          : {}),
        sources,
        untrusted: true,
      };
    };
    let result: unknown;
    switch (name) {
      case "wiki_rules":
      case "wiki_search": {
        const query = name === "wiki_search" ? schemas.wiki_search.parse(input) : null;
        const rows = await tx
          .select({ id: artifacts.id, title: artifacts.title, slug: artifacts.slug })
          .from(artifacts)
          .where(and(eq(artifacts.orgId, fence.orgId), eq(artifacts.projectId, wikiId)))
          .orderBy(asc(artifacts.id));
        const visible = [];
        for (const row of rows) {
          if (query ? !row.title.toLowerCase().includes(query.query.toLowerCase()) : row.slug !== "rules")
            continue;
          try {
            await ctx.page(row.id);
          } catch {
            continue;
          }
          visible.push(query ? { page: row.id, title: row.title } : await checkpoint(row.id));
          if (visible.length >= (query?.limit ?? 1)) break;
        }
        result = { results: visible, untrusted: true };
        break;
      }
      case "page_read": {
        const body = schemas.page_read.parse(input);
        const resource = await ctx.page(body.page);
        const lock = await docLockIn(tx, body.page);
        const cursor = (body as { cursor?: string }).cursor;
        const [article] = await tx
          .select({ kind: pages.kind })
          .from(pages)
          .innerJoin(versions, eq(versions.id, pages.versionId))
          .where(and(eq(versions.artifactId, resource.id), eq(versions.n, resource.row.latestVersion)))
          .limit(1);
        if (article?.kind === "article") {
          const draft = !!lock.row?.snapshot.length && can(ctx.caller, "artifact.edit", resource);
          let offset: string | undefined;
          if (cursor) {
            const match = /^(\d+):(\d+):(\d+)$/.exec(cursor);
            if (
              !match ||
              Number(match[1]) !== resource.row.latestVersion ||
              Number(match[2]) !== (draft ? lock.row?.seq : 0)
            )
              throw new ApiError("conflict", "Page changed. Read it again.");
            offset = match[3];
          }
          const read = await pageRead(ctx.scoped, ctx.caller, resource, { draft, cursor: offset }, lock);
          result = {
            ...read,
            nextCursor: read.nextCursor === null ? null : `${read.version}:${read.seq}:${read.nextCursor}`,
            untrusted: true,
          };
        } else result = await checkpoint(resource.id);
        if (result && typeof result === "object" && "sources" in result && Array.isArray(result.sources)) {
          const visible: string[] = [];
          for (const source of result.sources) {
            try {
              await ctx.page(source);
              visible.push(source);
            } catch {}
          }
          result.sources = visible;
        }
        break;
      }
      case "source_read": {
        const body = schemas.source_read.parse(input);
        result = await checkpoint(body.page, true, body.cursor, body.version);
        break;
      }
      case "page_edit": {
        const body = schemas.page_edit.parse(input);
        const resource = await ctx.page(body.page, true);
        const lock = await docLockIn(tx, body.page);
        await ensureDocLocked(ctx.scoped, lock, resource);
        if (lock.row?.kind !== "article") throw new ApiError("conflict", "Article draft unavailable.");
        result = await applyOps(
          ctx.scoped,
          ctx.caller,
          resource,
          { ...body.edit, agent: "Librarian" },
          undefined,
          lock,
          fence.runId,
        );
        break;
      }
      case "page_delegate_start": {
        const body = schemas.page_delegate_start.parse(input);
        result = await startRun(
          ctx.scoped,
          ctx.caller,
          await ctx.page(body.page, true),
          { ...body.start, agent: "Librarian" },
          tx,
        );
        break;
      }
      case "page_delegate_finish": {
        const body = schemas.page_delegate_finish.parse(input);
        const resource = await ctx.page(body.page, true);
        const run = await findRun(ctx.scoped, fence.orgId, body.run);
        if (!run || run.artifactId !== resource.id) throw missing();
        result = await finishRun(
          ctx.scoped,
          ctx.caller,
          resource,
          run,
          body.finish.message,
          await docLockIn(tx, resource.id),
        );
        break;
      }
      case "question": {
        const body = schemas.question.parse(input);
        const resource = await ctx.page(body.page);
        const [version] = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.artifactId, resource.id), eq(versions.n, body.checkpoint)));
        if (!version || body.checkpoint !== resource.row.latestVersion) throw missing();
        const [page] = (await tx.execute(
          sql`select page_key from pages where version_id = ${version.id} order by page_key limit 1`,
        )) as unknown as { page_key: string }[];
        if (!page) throw missing();
        await lockArtifact(tx, resource.id, "threads");
        const [existing] = await tx
          .select({ id: threads.id })
          .from(threads)
          .innerJoin(comments, eq(comments.threadId, threads.id))
          .innerJoin(
            activity,
            and(
              eq(activity.artifactId, threads.artifactId),
              sql`${activity.payload}->>'questionThread' = ${threads.id}::text`,
            ),
          )
          .where(
            and(
              eq(threads.artifactId, resource.id),
              eq(comments.body, body.text),
              sql`${activity.payload}->>'librarianRun' = ${fence.runId}`,
            ),
          )
          .limit(1);
        if (existing) {
          result = { threadId: existing.id, commentId: existing.id };
          break;
        }
        const [counter] = await tx
          .update(artifacts)
          .set({ threadCounter: sql`${artifacts.threadCounter} + 1` })
          .where(eq(artifacts.id, resource.id))
          .returning({ n: artifacts.threadCounter });
        if (!counter) throw missing();
        await tx.insert(threads).values({
          id: receipt.id,
          orgId: fence.orgId,
          artifactId: resource.id,
          n: counter.n,
          pageKey: page.page_key,
          createdVersion: body.checkpoint,
          authorPersonId: ctx.caller.createdBy,
          authorName: "Librarian",
          createdAt: deps.clock.now(),
        });
        await tx.insert(comments).values({
          id: receipt.id,
          threadId: receipt.id,
          orgId: fence.orgId,
          authorPersonId: ctx.caller.createdBy,
          authorName: "Librarian",
          agent: "Librarian",
          body: body.text,
          version: body.checkpoint,
          createdAt: deps.clock.now(),
        });
        await tx.insert(activity).values({
          id: crypto.randomUUID(),
          orgId: fence.orgId,
          artifactId: resource.id,
          projectId: wikiId,
          actorPersonId: ctx.caller.createdBy,
          agent: "Librarian",
          kind: "commented",
          payload: {
            thread: counter.n,
            version: body.checkpoint,
            librarianRun: fence.runId,
            questionThread: receipt.id,
          },
          createdAt: deps.clock.now(),
        });
        result = { threadId: receipt.id, commentId: receipt.id };
        break;
      }
      case "propose_page": {
        const body = schemas.propose_page.parse(input);
        await tx.insert(librarianProposals).values({
          ...body,
          id: receipt.id,
          orgId: fence.orgId,
          wikiId,
          runId: fence.runId,
          proposalKey: receipt.id,
          untrusted: true,
          status: "open",
          createdAt: deps.clock.now(),
        });
        result = { proposalId: receipt.id };
        break;
      }
      default:
        throw new ApiError("conflict", "Delegate transaction adapter unavailable.");
    }
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
      throw new ApiError("too_large", "Tool result too large.");
    return result;
  };
  return { authorizeTool, tool };
}
