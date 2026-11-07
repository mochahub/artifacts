import type { Context } from "hono";
import type { GoogleProvider } from "./auth/google.ts";
import type { RateLimits } from "./auth/rate-limit.ts";
import type { Clock } from "./clock.ts";
import type { Db } from "./db/index.ts";
import type { Env } from "./env.ts";
import type { Logger } from "./log.ts";
import type { MetadataFetch } from "./oauth/metadata.ts";
import type { Events } from "./realtime/events.ts";
import type { Bucket } from "./s3.ts";
import type { SandboxPool } from "./sandbox/pool.ts";

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
  sandbox: SandboxPool;
  events: Events;
  /** Whether a push message may be sent to this endpoint: only the browsers' own push services. */
  pushAllow(endpoint: string): boolean;
  /** Fetches an OAuth client's metadata document, from wherever its client_id points. */
  clientMetadata: MetadataFetch;
  google: GoogleProvider;
};
