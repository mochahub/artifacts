import { PublishCommit, PublishPrepare } from "@artifacts/schema";
import { BoardCreateRequest } from "@artifacts/schema/boards";
import { agentOf } from "../auth/caller.ts";
import { createBoard } from "../boards/create.ts";
import type { Deps } from "../deps.ts";
import { parseBody } from "../http/body.ts";
import type { Routes } from "../http/routes.ts";
import type { Publisher } from "./publisher.ts";

export function publishRoutes(routes: Routes, publisher: Publisher, deps: Deps) {
  routes.post("/api/publish/prepare", { action: "artifact.publish", inHandler: true }, async (c) =>
    c.json(await publisher.prepare(c.var, await parseBody(c, PublishPrepare))),
  );

  routes.post("/api/publish/commit", { action: "artifact.publish", inHandler: true }, async (c) =>
    c.json(await publisher.commit(c.var, await parseBody(c, PublishCommit))),
  );

  // A native-only board: the publish pipeline with an empty native canvas page `board` (14).
  routes.post("/api/boards", { action: "artifact.publish", inHandler: true }, async (c) =>
    c.json(
      await createBoard(
        deps,
        publisher,
        c.var,
        await parseBody(c, BoardCreateRequest),
        agentOf(c.var.caller, null),
      ),
    ),
  );
}
