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
  /**
   * The draft hub (13, "Replicas"): tells editors on every replica about a persisted update (`u`),
   * awareness (`a`) or a control message (`c`). Absent where nothing serves sockets, as in some tests.
   */
  docs?: {
    notify(artifactId: string, kind: "u" | "a" | "c", payload: unknown): void;
    /** An agent at work on the page, shown to editors until `AGENT_PRESENCE_MS` after its last call. */
    agentPresence(
      artifactId: string,
      author: { name?: string | null; personId?: string | null; key?: string },
      block: string | null,
      run: string | null,
    ): void;
  };
};
