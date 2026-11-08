import {
  LibrarianConfigEdit,
  LibrarianGeneration,
  LibrarianKeyWrite,
  LibrarianProvision,
} from "@artifacts/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { findArtifact, toProject } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import {
  editRuns,
  librarianConfig,
  librarianEvents,
  librarianKeys,
  librarianProposals,
  librarianReceipts,
  librarianRuns,
  projects,
  threads,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody, readLimited } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import type { Routes } from "../http/routes.ts";
import {
  ensureConfig,
  expectGeneration,
  fenceAll,
  loadSafeConfig,
  provisionIdentity,
  saveConfig,
} from "./config.ts";
import { encryptProviderKey, keyring } from "./keys.ts";
import { cancelRun, locked } from "./leases.ts";
import { authorizeProposal } from "./proposal-routes.ts";

export function librarianRoutes(routes: Routes, deps: Deps) {
  const manage = { action: "librarian.manage", recentAuth: true } as const;
  const logs = { action: "librarian.logs", recentAuth: true } as const;
  routes.get("/api/librarian/config", manage, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await loadSafeConfig(deps, c.var.org.id));
  });
  routes.put("/api/librarian/config", manage, async (c) => {
    c.header("Cache-Control", "no-store");
    await saveConfig(deps, c.var.org.id, c.var.caller.person.id, await parseBody(c, LibrarianConfigEdit));
    return c.json(await loadSafeConfig(deps, c.var.org.id));
  });
  routes.put("/api/librarian/provision", manage, async (c) => {
    c.header("Cache-Control", "no-store");
    await provisionIdentity(
      deps,
      c.var.org.id,
      c.var.caller.person.id,
      await parseBody(c, LibrarianProvision),
    );
    return c.json(await loadSafeConfig(deps, c.var.org.id));
  });
  routes.put("/api/librarian/key", manage, async (c) => {
    c.header("Cache-Control", "no-store");
    let input: ReturnType<typeof LibrarianKeyWrite.parse>;
    try {
      input = LibrarianKeyWrite.parse(
        JSON.parse(new TextDecoder().decode(await readLimited(c.req.raw, 8192))),
      );
    } catch {
      throw new ApiError("invalid", "Invalid credential request.");
    }
    try {
      await locked(deps, c.var.org.id, async (tx) => {
        const config = await ensureConfig(tx, c.var.org.id);
        expectGeneration(config.generation, input.expectedGeneration);
        const generation = config.generation + 1;
        const bytes = Buffer.from(input.key);
        let envelope: ReturnType<typeof encryptProviderKey>;
        try {
          envelope = encryptProviderKey(bytes, c.var.org.id, generation, keyring(deps));
        } finally {
          bytes.fill(0);
        }
        await fenceAll(deps, tx, c.var.org.id);
        const values = {
          orgId: c.var.org.id,
          generation,
          envelope,
          updatedBy: c.var.caller.person.id,
          updatedAt: deps.clock.now(),
        };
        await tx
          .insert(librarianKeys)
          .values(values)
          .onConflictDoUpdate({ target: librarianKeys.orgId, set: values });
        await tx
          .update(librarianConfig)
          .set({ enabled: false, generation, updatedBy: c.var.caller.person.id, updatedAt: deps.clock.now() })
          .where(eq(librarianConfig.orgId, c.var.org.id));
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid", "Provider credential could not be stored.");
    }
    return c.body(null, 204);
  });
  routes.delete("/api/librarian/key", manage, async (c) => {
    c.header("Cache-Control", "no-store");
    const input = await parseBody(c, LibrarianGeneration);
    await locked(deps, c.var.org.id, async (tx) => {
      const config = await ensureConfig(tx, c.var.org.id);
      expectGeneration(config.generation, input.expectedGeneration);
      await fenceAll(deps, tx, c.var.org.id);
      await tx
        .update(librarianConfig)
        .set({
          enabled: false,
          generation: config.generation + 1,
          updatedBy: c.var.caller.person.id,
          updatedAt: deps.clock.now(),
        })
        .where(eq(librarianConfig.orgId, c.var.org.id));
      await tx.delete(librarianKeys).where(eq(librarianKeys.orgId, c.var.org.id));
    });
    return c.body(null, 204);
  });
  // Foundation logs intentionally contain no resource result ids, prompts, envelopes or provider bodies.
  const safe = (row: typeof librarianRuns.$inferSelect) => ({
    inboxId: row.inboxId ?? undefined,
    id: row.id,
    wikiId: row.wikiId,
    state: row.state,
    model: row.model,
    configGeneration: row.configGeneration,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    usage: {
      settledMicrousd: checked(row.settled),
      uncertainMicrousd: checked(row.uncertain),
      reservedMicrousd: checked(row.reserved),
    },
    result: { editRunIds: [] as string[], proposalIds: [] as string[], questionIds: [] as string[] },
  });
  const visibleResults = async (row: typeof librarianRuns.$inferSelect, caller: Caller) => {
    const result = safe(row);
    const [wiki] = await deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, row.wikiId), eq(projects.orgId, row.orgId)));
    // A log grant does not grant access to content or proposals.
    if (wiki && can(caller, "project.publish", await toProject(deps, wiki))) {
      const proposals = await deps.db
        .select()
        .from(librarianProposals)
        .where(
          and(
            eq(librarianProposals.runId, row.id),
            eq(librarianProposals.orgId, row.orgId),
            eq(librarianProposals.wikiId, wiki.id),
          ),
        );
      for (const p of proposals) {
        try {
          await authorizeProposal(deps, caller, p);
          result.result.proposalIds.push(p.id as never);
        } catch (error) {
          if (!(error instanceof ApiError && error.code === "not_found")) throw error;
        }
      }
    }
    const receipts = await deps.db
      .select()
      .from(librarianReceipts)
      .where(and(eq(librarianReceipts.orgId, row.orgId), eq(librarianReceipts.runId, row.id)));
    for (const receipt of receipts) {
      const value = receipt.result as { id?: unknown; threadId?: unknown } | null;
      if (!value || typeof value !== "object") continue;
      if (typeof value.id === "string") {
        const [run] = await deps.db
          .select()
          .from(editRuns)
          .where(and(eq(editRuns.orgId, row.orgId), eq(editRuns.id, value.id)));
        const page = run ? await findArtifact(deps, row.orgId, run.artifactId) : null;
        if (
          page?.projectId === row.wikiId &&
          can(caller, "artifact.edit", page) &&
          !result.result.editRunIds.includes(value.id)
        )
          result.result.editRunIds.push(value.id);
      }
      if (typeof value.threadId === "string") {
        const [thread] = await deps.db
          .select()
          .from(threads)
          .where(and(eq(threads.orgId, row.orgId), eq(threads.id, value.threadId)));
        const page = thread ? await findArtifact(deps, row.orgId, thread.artifactId) : null;
        if (page?.projectId === row.wikiId && can(caller, "artifact.read", page))
          result.result.questionIds.push(value.threadId);
      }
    }
    return result;
  };
  routes.get("/api/librarian/runs", logs, async (c) => {
    c.header("Cache-Control", "no-store");
    const cursor = c.req.query("cursor");
    if (cursor && !/^[0-9a-f-]{36}$/.test(cursor)) throw new ApiError("invalid", "Invalid cursor.");
    const [after] = cursor
      ? await deps.db
          .select()
          .from(librarianRuns)
          .where(and(eq(librarianRuns.id, cursor), eq(librarianRuns.orgId, c.var.org.id)))
      : [];
    if (cursor && !after) throw new ApiError("invalid", "Invalid cursor.");
    const rows = await deps.db
      .select()
      .from(librarianRuns)
      .where(
        and(
          eq(librarianRuns.orgId, c.var.org.id),
          after
            ? or(
                lt(librarianRuns.startedAt, after.startedAt),
                and(eq(librarianRuns.startedAt, after.startedAt), lt(librarianRuns.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(librarianRuns.startedAt), desc(librarianRuns.id))
      .limit(51);
    return c.json({
      runs: await Promise.all(rows.slice(0, 50).map((r) => visibleResults(r, c.var.caller))),
      nextCursor: rows.length > 50 ? rows[49]?.id : undefined,
    });
  });
  routes.get("/api/librarian/runs/:id", logs, async (c) => {
    c.header("Cache-Control", "no-store");
    const [row] = await deps.db
      .select()
      .from(librarianRuns)
      .where(and(eq(librarianRuns.orgId, c.var.org.id), eq(librarianRuns.id, c.req.param("id") ?? "")));
    if (!row) throw new ApiError("not_found", "Not found.");
    return c.json(await visibleResults(row, c.var.caller));
  });
  routes.get("/api/librarian/runs/:id/events", logs, async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id") ?? "";
    const [run] = await deps.db
      .select()
      .from(librarianRuns)
      .where(and(eq(librarianRuns.id, id), eq(librarianRuns.orgId, c.var.org.id)));
    if (!run) throw new ApiError("not_found", "Not found.");
    const cursor = c.req.query("cursor");
    if (cursor && !/^[0-9a-f-]{36}$/.test(cursor)) throw new ApiError("invalid", "Invalid cursor.");
    const [after] = cursor
      ? await deps.db
          .select()
          .from(librarianEvents)
          .where(
            and(
              eq(librarianEvents.id, cursor),
              eq(librarianEvents.runId, id),
              eq(librarianEvents.orgId, c.var.org.id),
            ),
          )
      : [];
    if (cursor && !after) throw new ApiError("invalid", "Invalid cursor.");
    const rows = await deps.db
      .select()
      .from(librarianEvents)
      .where(
        and(
          eq(librarianEvents.runId, id),
          eq(librarianEvents.orgId, c.var.org.id),
          after
            ? or(
                lt(librarianEvents.createdAt, after.createdAt),
                and(eq(librarianEvents.createdAt, after.createdAt), lt(librarianEvents.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(librarianEvents.createdAt), desc(librarianEvents.id))
      .limit(101);
    return c.json({
      events: rows
        .slice(0, 100)
        .map((r) => ({ id: r.id, code: r.code, createdAt: r.createdAt.toISOString() })),
      nextCursor: rows.length > 100 ? rows[99]?.id : undefined,
    });
  });
  routes.post("/api/librarian/runs/:id/cancel", manage, async (c) => {
    c.header("Cache-Control", "no-store");
    await cancelRun(deps, c.var.org.id, c.req.param("id") ?? "");
    return c.json({ ok: true });
  });
}
function checked(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Money exceeds JSON safe integer");
  return n;
}
