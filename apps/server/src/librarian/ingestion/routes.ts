import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { librarianInbox, librarianProposals, librarianRuns } from "../../db/schema.ts";
import type { Deps } from "../../deps.ts";
import { parseBody } from "../../http/body.ts";
import { ApiError } from "../../http/errors.ts";
import { projectParam } from "../../http/resources.ts";
import type { Routes } from "../../http/routes.ts";
import { loadSafeConfig } from "../index.ts";
import { finishLocked, locked } from "../leases.ts";
import { authorizeProposal } from "../proposal-routes.ts";
import {
  authorize,
  createUpload,
  EnqueueRequest,
  enqueueSource,
  ownedInbox,
  safeInbox,
  submitter,
  UploadRequest,
} from "./index.ts";

/** Root owner registers once on the standard Routes instance (version/auth/CSRF chain). */
export function ingestionRoutes(routes: Routes, deps: Deps) {
  // project.publish is the existing permission primitive for the proposed librarian.submit action.
  const guard = { action: "project.publish", resource: projectParam(deps) } as const;
  routes.post("/api/wikis/:slug/inbox/uploads", guard, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await createUpload(
        deps,
        { orgId: c.var.org.id, wikiId: c.var.resource.id, caller: c.var.caller },
        await parseBody(c, UploadRequest),
      ),
      201,
    );
  });
  routes.post("/api/wikis/:slug/inbox", guard, async (c) => {
    c.header("Cache-Control", "no-store");
    const result = await enqueueSource(
      deps,
      { orgId: c.var.org.id, wikiId: c.var.resource.id, caller: c.var.caller },
      await parseBody(c, EnqueueRequest),
    );
    const config = await loadSafeConfig(deps, c.var.org.id);
    return c.json(
      {
        ...result.item,
        message:
          deps.env.librarianAllowed && config.enabled
            ? "Saved to inbox."
            : "Saved to inbox. Librarian is off.",
      },
      result.replay ? 200 : 202,
    );
  });
  routes.get("/api/wikis/:slug/inbox", guard, async (c) => {
    c.header("Cache-Control", "no-store");
    const input = { orgId: c.var.org.id, wikiId: c.var.resource.id, caller: c.var.caller };
    await authorize(deps, input);
    const cursor = c.req.query("cursor");
    let before: { at: string; id: string } | undefined;
    if (cursor) {
      try {
        if (cursor.length > 256) throw new Error();
        before = z
          .object({ at: z.iso.datetime(), id: z.uuid() })
          .strict()
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
      } catch {
        throw new ApiError("invalid", "Invalid cursor.");
      }
    }
    const rows = await deps.db
      .select()
      .from(librarianInbox)
      .where(
        and(
          eq(librarianInbox.orgId, input.orgId),
          eq(librarianInbox.wikiId, input.wikiId),
          input.caller.kind === "person" &&
            (input.caller.person.role === "admin" || input.caller.person.role === "owner")
            ? undefined
            : eq(librarianInbox.submittedBy, submitter(input.caller)),
          before
            ? or(
                lt(librarianInbox.submittedAt, new Date(before.at)),
                and(eq(librarianInbox.submittedAt, new Date(before.at)), lt(librarianInbox.id, before.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(librarianInbox.submittedAt), desc(librarianInbox.id))
      .limit(50);
    return c.json({
      items: rows.map(safeInbox),
      nextCursor:
        rows.length === 50 && rows[49]
          ? Buffer.from(JSON.stringify({ at: rows[49].submittedAt.toISOString(), id: rows[49].id })).toString(
              "base64url",
            )
          : null,
    });
  });
  routes.get("/api/wikis/:slug/inbox/:id", guard, async (c) => {
    c.header("Cache-Control", "no-store");
    const row = await ownedInbox(
      deps,
      { orgId: c.var.org.id, wikiId: c.var.resource.id, caller: c.var.caller },
      c.req.param("id") ?? "",
    );
    const proposals = row.runId
      ? await deps.db
          .select()
          .from(librarianProposals)
          .where(
            and(
              eq(librarianProposals.runId, row.runId),
              eq(librarianProposals.orgId, row.orgId),
              eq(librarianProposals.wikiId, row.wikiId),
            ),
          )
      : [];
    const proposalIds: string[] = [];
    for (const p of proposals) {
      try {
        await authorizeProposal(deps, c.var.caller, p);
        proposalIds.push(p.id);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "not_found")) throw error;
      }
    }
    return c.json({ ...safeInbox(row), runId: row.runId ?? undefined, proposalIds });
  });
  routes.post("/api/wikis/:slug/inbox/:id/cancel", guard, async (c) => {
    c.header("Cache-Control", "no-store");
    const row = await locked(deps, c.var.org.id, async (tx) => {
      const scoped = { ...deps, db: tx } as unknown as Deps;
      const row = await ownedInbox(
        scoped,
        { orgId: c.var.org.id, wikiId: c.var.resource.id, caller: c.var.caller },
        c.req.param("id") ?? "",
      );
      if (row.runId) {
        const [run] = await tx
          .select()
          .from(librarianRuns)
          .where(and(eq(librarianRuns.id, row.runId), eq(librarianRuns.orgId, row.orgId)));
        if (run) await finishLocked(deps, tx, run, "cancelled");
      }
      await tx
        .update(librarianInbox)
        .set({ status: "cancelled", updatedAt: deps.clock.now() })
        .where(eq(librarianInbox.id, row.id));
      return row;
    });
    return c.json({ ...safeInbox(row), status: "cancelled" });
  });
}
