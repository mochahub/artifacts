import type { ApiErrorBody } from "@artifacts/schema";
import { Hono } from "hono";
import { routePath } from "hono/route";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "../log.ts";
import { VERSION } from "../version.ts";
import { ApiError } from "./errors.ts";

type Vars = { Variables: { requestId: string } };

const errorBody = (code: string, message: string, details: Record<string, unknown> = {}): ApiErrorBody => ({
  error: { code, message, details },
});

/** What all three ports share: request ids, the version header, JSON logs and the error format. */
export function createApp(log: Logger) {
  const app = new Hono<Vars>();

  app.use(async (c, next) => {
    const requestId = Bun.randomUUIDv7();
    const started = performance.now();
    c.set("requestId", requestId);
    await next();
    c.header("Artifacts-Version", VERSION);
    c.header("X-Request-Id", requestId);
    // Log the route pattern, never the path: paths can hold share, invite and content tokens.
    log.info("request", {
      requestId,
      method: c.req.method,
      route: routePath(c),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (typeof error.details.retryAfter === "number")
        c.header("Retry-After", String(error.details.retryAfter));
      return c.json(
        errorBody(error.code, error.message, error.details),
        error.status as ContentfulStatusCode,
      );
    }
    log.error("unhandled error", {
      requestId: c.get("requestId"),
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return c.json(errorBody("internal", "Something went wrong."), 500);
  });

  app.notFound((c) => c.json(errorBody("not_found", "Not found."), 404));

  return app;
}
