import { safeEqual } from "../auth/secrets.ts";
import type { Env } from "../env.ts";
import { createApp } from "../http/app.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../log.ts";

/** Operators' job triggers; jobs register here from M7 on (05, "Clean-up"). */
export function createInternalApp(env: Env, log: Logger, jobs: Record<string, () => Promise<unknown>> = {}) {
  const app = createApp(log);

  app.post("/internal/jobs/:name", async (c) => {
    if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${env.opsSecret}`)) {
      throw new ApiError("unauthenticated", "A valid OPS_SECRET is required.");
    }
    const job = Object.hasOwn(jobs, c.req.param("name")) ? jobs[c.req.param("name")] : undefined;
    if (!job) throw new ApiError("not_found", "No such job.");
    return c.json({ ok: true, result: (await job()) ?? null });
  });

  return app;
}
