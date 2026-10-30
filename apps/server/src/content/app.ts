import type { Env } from "../env.ts";
import { createApp } from "../http/app.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../log.ts";

/** Live previews. Bundle files arrive in M3 and backends in M10; every path is 404 until then. */
export function createContentApp(env: Env, log: Logger) {
  const app = createApp(log);
  const host = env.contentUrl && new URL(env.contentUrl).host;

  app.all("/t/*", (c) => {
    if (c.req.header("host")?.toLowerCase() !== host) {
      throw new ApiError("misdirected", "This server doesn't answer on that host.");
    }
    throw new ApiError("not_found", "Not found.");
  });

  return app;
}
