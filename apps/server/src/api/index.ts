import { publishRoutes } from "../publish/routes.ts";
import { authRoutes } from "./auth.ts";
import type { Deps } from "./deps.ts";
import { deviceRoutes } from "./device.ts";
import { fileRoutes } from "./files.ts";
import type { Routes } from "./routes.ts";
import { setupRoutes } from "./setup.ts";

/** Every /api route on the viewer port. */
export function mountApi(routes: Routes, deps: Deps) {
  setupRoutes(routes, deps);
  authRoutes(routes, deps);
  deviceRoutes(routes, deps);
  publishRoutes(routes, deps);
  fileRoutes(routes, deps);
}
