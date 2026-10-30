import type { Context } from "hono";
import type { RateLimits } from "../auth/rate-limit.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../log.ts";
import type { Events } from "../realtime/events.ts";
import type { Bucket } from "../s3.ts";
import type { SandboxPool } from "../sandbox/pool.ts";

/** What route handlers need from the server. */
export type Deps = {
  env: Env;
  db: Db;
  bucket: Bucket;
  clock: Clock;
  log: Logger;
  limits: RateLimits;
  /** Every viewer origin, including the home domain once setup has run. */
  origins(): Promise<string[]>;
  clientIp(c: Context): string;
  /** Null until the first backend runs on a server with none; tests can leave it out. */
  sandbox: SandboxPool | null;
  events: Events;
  /** Tests point this at a local push service. */
  pushAllow?: (endpoint: string) => boolean;
};
