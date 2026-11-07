import { CreateWiki } from "@artifacts/schema";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import { etagJson } from "../http/etag.ts";
import { artifactParam, projectParam } from "../http/resources.ts";
import type { Routes } from "../http/routes.ts";
import { artifactLinks, createWiki, wikiSpace } from "./service.ts";
export function wikiRoutes(routes: Routes, deps: Deps) {
  routes.post("/api/wikis", { action: "project.create" }, async (c) => {
    const result = await createWiki(deps, c.var.org.id, c.var.caller, await parseBody(c, CreateWiki));
    return c.json(result.body, result.created ? 201 : 200);
  });
  routes.get("/api/wikis/:slug", { action: "project.read", resource: projectParam(deps) }, async (c) =>
    etagJson(c, await wikiSpace(deps, c.var.org.id, c.var.caller, c.var.resource)),
  );
  routes.get(
    "/api/artifacts/:id/links",
    { action: "artifact.read", resource: artifactParam(deps) },
    async (c) => etagJson(c, await artifactLinks(deps, c.var.org.id, c.var.caller, c.var.resource)),
  );
}
