import { createHash, timingSafeEqual } from "node:crypto";
import type { Env } from "../env.ts";
import { createApp } from "../http/app.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../log.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Operators' job triggers; jobs register here from M7 on (05, "Clean-up"). */
export function createInternalApp(env: Env, log: Logger, jobs: Record<string, () => Promise<void>> = {}) {
  const app = createApp(log);
  const expected = digest(`Bearer ${env.opsSecret}`);

  app.post("/internal/jobs/:name", async (c) => {
    if (!timingSafeEqual(digest(c.req.header("authorization") ?? ""), expected)) {
      throw new ApiError("unauthenticated", "A valid OPS_SECRET is required.");
    }
    const job = Object.hasOwn(jobs, c.req.param("name")) ? jobs[c.req.param("name")] : undefined;
    if (!job) throw new ApiError("not_found", "No such job.");
    await job();
    return c.json({ ok: true });
  });

  return app;
}
