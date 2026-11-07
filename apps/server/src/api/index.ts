import { createPasskeys } from "../auth/passkeys.ts";
import { dataRoutes } from "../data/routes.ts";
import type { Deps } from "../deps.ts";
import type { Routes } from "../http/routes.ts";
import { brandRoutes } from "../library/brand.ts";
import { libraryRoutes } from "../library/routes.ts";
import { mcpRoutes } from "../mcp/routes.ts";
import { oauthRoutes } from "../oauth/routes.ts";
import { createPublisher } from "../publish/publisher.ts";
import { publishRoutes } from "../publish/routes.ts";
import { pushRoutes } from "../push/routes.ts";
import { eventRoutes } from "../realtime/routes.ts";
import { reviewRoutes } from "../review/routes.ts";
import { createReview } from "../review/service.ts";
import { wikiRoutes } from "../wiki/routes.ts";
import { authRoutes } from "./auth.ts";
import { deviceRoutes } from "./device.ts";
import { fileRoutes } from "./files.ts";
import { googleRoutes } from "./google.ts";
import { lifecycleRoutes } from "./lifecycle.ts";
import { listRoutes } from "./lists.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { peopleRoutes } from "./people.ts";
import { projectRoutes } from "./projects.ts";
import { setupRoutes } from "./setup.ts";
import { sharingRoutes } from "./sharing.ts";
import { teamRoutes } from "./teams.ts";
import { versionRoutes } from "./versions.ts";

/** Every /api route on the viewer port. */
export function mountApi(routes: Routes, deps: Deps) {
  const passkeys = createPasskeys(deps);
  const publisher = createPublisher(deps);
  const review = createReview(deps);

  setupRoutes(routes, deps);
  passkeyRoutes(routes, deps, passkeys);
  authRoutes(routes, deps, passkeys);
  googleRoutes(routes, deps);
  peopleRoutes(routes, deps);
  sharingRoutes(routes, deps);
  teamRoutes(routes, deps);
  projectRoutes(routes, deps);
  deviceRoutes(routes, deps);
  publishRoutes(routes, publisher);
  listRoutes(routes, deps);
  wikiRoutes(routes, deps);
  libraryRoutes(routes, deps);
  brandRoutes(routes, deps);
  reviewRoutes(routes, deps, review);
  versionRoutes(routes, deps);
  lifecycleRoutes(routes, deps);
  fileRoutes(routes, deps);
  dataRoutes(routes, deps);
  eventRoutes(routes, deps);
  pushRoutes(routes, deps);
  oauthRoutes(routes, deps);
  mcpRoutes(routes, deps, { publisher, review });
}
