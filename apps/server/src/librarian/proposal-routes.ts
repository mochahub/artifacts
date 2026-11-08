import { LibrarianProposal } from "@artifacts/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { findArtifact, toProject } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { librarianProposals, projects } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { projectParam } from "../http/resources.ts";
import type { Routes } from "../http/routes.ts";
import { createReviewedProposal } from "./creation.ts";
import { reviewProposal } from "./proposals.ts";

const missing = () => new ApiError("not_found", "Not found.");
/** Proposals contain derived source text: visibility of every citation is required even on replay. */
export async function authorizeProposal(
  deps: Deps,
  caller: Caller,
  p: typeof librarianProposals.$inferSelect,
) {
  if (caller.kind !== "person") throw missing();
  const [wiki] = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, p.wikiId), eq(projects.orgId, p.orgId)));
  if (wiki?.kind !== "wiki" || !can(caller, "project.publish", await toProject(deps, wiki))) throw missing();
  for (const id of p.sources) {
    const source = await findArtifact(deps, p.orgId, id);
    if (!source || source.project.id !== p.wikiId || !can(caller, "artifact.read", source)) throw missing();
  }
  if (p.createdArtifactId) {
    const created = await findArtifact(deps, p.orgId, p.createdArtifactId);
    if (!created || created.project.id !== p.wikiId || !can(caller, "artifact.read", created))
      throw missing();
  }
}
export function proposalRoutes(routes: Routes, deps: Deps) {
  const guard = { action: "project.publish", resource: projectParam(deps) } as const;
  const path = "/api/wikis/:slug/proposals/:id";
  routes.get(path, guard, async (c) => {
    c.header("Cache-Control", "no-store");
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw missing();
    const [p] = await deps.db
      .select()
      .from(librarianProposals)
      .where(
        and(
          eq(librarianProposals.id, id.data),
          eq(librarianProposals.orgId, c.var.org.id),
          eq(librarianProposals.wikiId, c.var.resource.id),
        ),
      );
    if (!p) throw missing();
    await authorizeProposal(deps, c.var.caller, p);
    return c.json(
      LibrarianProposal.parse({
        id: p.id,
        runId: p.runId,
        wikiId: p.wikiId,
        title: p.title,
        summary: p.summary,
        markdown: p.markdown,
        sources: p.sources,
        untrusted: p.untrusted,
        status: p.status,
        createdArtifactId: p.createdArtifactId ?? undefined,
      }),
    );
  });
  for (const reject of [false, true])
    routes.post(`${path}/${reject ? "reject" : "create"}`, guard, async (c) => {
      c.header("Cache-Control", "no-store");
      if (c.var.caller.kind !== "person") throw missing();
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) throw missing();
      const body = await parseBody(
        c,
        reject
          ? z.strictObject({ expectedStatus: z.literal("open") })
          : z.strictObject({ expectedStatus: z.literal("open"), requestId: z.uuid() }),
      );
      if (!reject && "requestId" in body) {
        const result = await createReviewedProposal(deps, {
          orgId: c.var.org.id,
          wikiId: c.var.resource.id,
          proposalId: id.data,
          caller: c.var.caller,
          requestId: z.uuid().parse(body.requestId),
        });
        return c.json(result, result.replay ? 200 : 201);
      }
      const result = await reviewProposal(
        deps,
        {
          orgId: c.var.org.id,
          wikiId: c.var.resource.id,
          proposalId: id.data,
          personId: c.var.caller.person.id,
          reject,
        },
        async (tx, p) => authorizeProposal({ ...deps, db: tx } as unknown as Deps, c.var.caller, p),
        async () => {
          throw new Error("Reject review cannot create an artifact.");
        },
      );
      return c.json(result);
    });
}
