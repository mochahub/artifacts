import { dataRoutes } from "../data/routes.ts";
import { brandRoutes } from "../library/brand.ts";
import { libraryRoutes } from "../library/routes.ts";
import { mcpRoutes } from "../mcp/routes.ts";
import { oauthRoutes } from "../oauth/routes.ts";
import { createPublisher, publishRoutes } from "../publish/routes.ts";
import { pushRoutes } from "../push/notify.ts";
import { eventRoutes } from "../realtime/events.ts";
import { reviewRoutes } from "../review/routes.ts";
import { authRoutes } from "./auth.ts";
import type { Deps } from "./deps.ts";
import { deviceRoutes } from "./device.ts";
import { fileRoutes } from "./files.ts";
import { lifecycleRoutes } from "./lifecycle.ts";
import { listRoutes } from "./lists.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { peopleRoutes } from "./people.ts";
import { projectRoutes } from "./projects.ts";
import type { Routes } from "./routes.ts";
import { setupRoutes } from "./setup.ts";
import { sharingRoutes } from "./sharing.ts";
import { teamRoutes } from "./teams.ts";
import { versionRoutes } from "./versions.ts";

/** Every /api route on the viewer port. */
export function mountApi(routes: Routes, deps: Deps) {
  setupRoutes(routes, deps);
  const passkeys = passkeyRoutes(routes, deps);
  authRoutes(routes, deps, passkeys);
  peopleRoutes(routes, deps);
  sharingRoutes(routes, deps);
  teamRoutes(routes, deps);
  projectRoutes(routes, deps);
  deviceRoutes(routes, deps);
  const publisher = createPublisher(deps);
  publishRoutes(routes, publisher);
  listRoutes(routes, deps);
  libraryRoutes(routes, deps);
  brandRoutes(routes, deps);
  const review = reviewRoutes(routes, deps);
  versionRoutes(routes, deps);
  lifecycleRoutes(routes, deps);
  fileRoutes(routes, deps);
  dataRoutes(routes, deps);
  eventRoutes(routes, deps);
  pushRoutes(routes, deps);
  oauthRoutes(routes, deps);
  mcpRoutes(routes, deps, { publisher, review });
}
