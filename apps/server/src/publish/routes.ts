import { PublishCommit, PublishPrepare } from "@artifacts/schema";
import { parseBody } from "../http/body.ts";
import type { Routes } from "../http/routes.ts";
import type { Publisher } from "./publisher.ts";

export function publishRoutes(routes: Routes, publisher: Publisher) {
  routes.post("/api/publish/prepare", { action: "artifact.publish", inHandler: true }, async (c) =>
    c.json(await publisher.prepare(c.var, await parseBody(c, PublishPrepare))),
  );

  routes.post("/api/publish/commit", { action: "artifact.publish", inHandler: true }, async (c) =>
    c.json(await publisher.commit(c.var, await parseBody(c, PublishCommit))),
  );
}
