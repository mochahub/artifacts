import { publishRoutes } from "../publish/routes.ts";
import { reviewRoutes } from "../review/routes.ts";
import { authRoutes } from "./auth.ts";
import type { Deps } from "./deps.ts";
import { deviceRoutes } from "./device.ts";
import { fileRoutes } from "./files.ts";
import { lifecycleRoutes } from "./lifecycle.ts";
import { listRoutes } from "./lists.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { peopleRoutes } from "./people.ts";
import type { Routes } from "./routes.ts";
import { setupRoutes } from "./setup.ts";
import { sharingRoutes } from "./sharing.ts";
import { versionRoutes } from "./versions.ts";

/** Every /api route on the viewer port. */
export function mountApi(routes: Routes, deps: Deps) {
  setupRoutes(routes, deps);
  const passkeys = passkeyRoutes(routes, deps);
  authRoutes(routes, deps, passkeys);
  peopleRoutes(routes, deps);
  sharingRoutes(routes, deps);
  deviceRoutes(routes, deps);
  publishRoutes(routes, deps);
  listRoutes(routes, deps);
  reviewRoutes(routes, deps);
  versionRoutes(routes, deps);
  lifecycleRoutes(routes, deps);
  fileRoutes(routes, deps);
}
