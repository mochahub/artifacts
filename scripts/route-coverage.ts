// Fails if an API route was registered but no test ever reached it ("every route gets a test").

import type { Deps } from "../apps/server/src/api/deps.ts";
import { mountApi } from "../apps/server/src/api/index.ts";
import { Routes } from "../apps/server/src/api/routes.ts";
import { RateLimits } from "../apps/server/src/auth/rate-limit.ts";
import { systemClock } from "../apps/server/src/clock.ts";
import { connect } from "../apps/server/src/db/index.ts";
import { createApp } from "../apps/server/src/http/app.ts";

const file = process.argv[2] as string;
const log = { debug() {}, info() {}, warn() {}, error() {} };
const app = createApp(log);
const routes = new Routes(app);
// Registering a route uses none of these: handlers close over them and aren't called here.
mountApi(routes, {
  db: connect("postgres://unused").db,
  clock: systemClock,
  limits: new RateLimits(systemClock),
  log,
} as unknown as Deps);

const hits = new Set((await Bun.file(file).text()).split("\n"));
const missed = routes.list.map((r) => `${r.method} ${r.path}`).filter((r) => !hits.has(r));
if (missed.length > 0) {
  console.error(`No test reached these routes:\n${missed.join("\n")}`);
  process.exit(1);
}
console.log(`Every one of the ${routes.list.length} API routes was reached by a test.`);
process.exit(0);
