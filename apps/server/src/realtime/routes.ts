import { findArtifact } from "../auth/access.ts";
import { limiterKey } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { currentCaller } from "../auth/resolve.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { isUuid } from "../http/params.ts";
import type { ApiContext, Routes } from "../http/routes.ts";

/** Each stream ends here at the latest, so nothing about it can go stale for longer. */
const STREAM_MS = 5 * 60_000;
const MAX_STREAMS_PER_CALLER = 10;

export function eventRoutes(routes: Routes, deps: Deps) {
  const artifact = async (c: ApiContext) => {
    const id = c.req.query("artifact");
    const found = isUuid(id) ? await findArtifact(deps, c.get("org").id, id) : null;
    if (!found) throw new ApiError("not_found", "Not found.");
    return found;
  };
  const streams = new Map<string, number>();

  routes.get("/api/events", { action: "artifact.read", resource: artifact }, async (c) => {
    const { resource, caller } = c.var;
    const who = limiterKey(caller) ?? c.var.org.id;
    const open = streams.get(who) ?? 0;
    if (open >= MAX_STREAMS_PER_CALLER) throw new ApiError("rate_limited", "Too many live connections.");
    streams.set(who, open + 1);

    // Bun closes a quiet connection after 10 seconds unless told otherwise.
    (c.env as { timeout?(request: Request, seconds: number): void } | undefined)?.timeout?.(c.req.raw, 0);
    const encoder = new TextEncoder();
    /** Losing a team can take many artifacts away at once, so a stream looks again on every beat. */
    const stillAllowed = async () => {
      try {
        const [fresh, current] = await Promise.all([
          currentCaller(deps, c.var.org, caller),
          findArtifact(deps, c.get("org").id, resource.id),
        ]);
        return fresh !== null && current !== null && can(fresh, "artifact.read", current);
      } catch {
        return false; // The browser reconnects, and that goes through the guard.
      }
    };
    let finish = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => controller.enqueue(encoder.encode(text));
        const unsubscribe = deps.events.subscribe(resource.id, ({ type, data }) => {
          write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        let done = false;
        const end = () => {
          if (done) return;
          finish();
          controller.close();
        };
        const heartbeat = setInterval(async () => {
          const allowed = await stillAllowed();
          if (done) return;
          if (allowed) write(": ok\n\n");
          else end();
        }, deps.events.heartbeatMs);
        const limit = setTimeout(end, STREAM_MS);
        const forget = deps.events.onLost(end);
        finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
          forget();
          clearInterval(heartbeat);
          clearTimeout(limit);
          const left = (streams.get(who) ?? 1) - 1;
          if (left > 0) streams.set(who, left);
          else streams.delete(who);
        };
        write(": ok\n\n");
      },
      cancel() {
        finish();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
