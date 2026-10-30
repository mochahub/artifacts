import postgres from "postgres";
import { findArtifact, isUuid } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import type { ApiContext, Routes } from "../api/routes.ts";
import { ApiError } from "../http/errors.ts";

export type EventType = "thread" | "comment" | "version" | "decision" | "data";
type Message = { artifact: string; type: EventType; data: Record<string, unknown> };

const CHANNEL = "artifacts_events";
const HEARTBEAT_MS = 25_000;
/** Closing often means access is checked again on each reconnect, by the same guard as anything else. */
const STREAM_MS = 5 * 60_000;
const MAX_STREAMS_PER_CALLER = 10;

/** Events hold no content, only that something changed, so a caller fetches it through its own access. */
export class Events {
  private readonly listeners = new Map<string, Set<(message: Message) => void>>();
  private readonly client: postgres.Sql;

  constructor(url: string) {
    this.client = postgres(url, { max: 1, onnotice: () => {} });
  }

  /** Fans out across replicas (03). Waits for LISTEN, so no event sent after boot is missed. */
  async start() {
    await this.client.listen(CHANNEL, (payload) => {
      const message = JSON.parse(payload) as Message;
      for (const listener of this.listeners.get(message.artifact) ?? []) listener(message);
    });
  }

  /** Never fails the write it follows: realtime is a nudge, and polling catches anything missed. */
  emit(artifact: string, type: EventType, data: Record<string, unknown> = {}) {
    const payload = JSON.stringify({ artifact, type, data });
    return this.client.notify(CHANNEL, payload).catch(() => {});
  }

  subscribe(artifact: string, listener: (message: Message) => void) {
    const set = this.listeners.get(artifact) ?? new Set();
    set.add(listener);
    this.listeners.set(artifact, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(artifact);
    };
  }

  stop() {
    return this.client.end({ timeout: 1 });
  }
}

export function eventRoutes(routes: Routes, deps: Deps) {
  const artifact = async (c: ApiContext) => {
    const id = c.req.query("artifact");
    const found = isUuid(id) ? await findArtifact(deps, c.get("org").id, id) : null;
    if (!found) throw new ApiError("not_found", "Not found.");
    return found;
  };
  const streams = new Map<string, number>();

  routes.get("/api/events", { action: "artifact.read", resource: artifact }, async (c) => {
    const resource = await artifact(c as ApiContext);
    const caller = c.get("caller");
    const who =
      "person" in caller ? caller.person.id : "guestId" in caller ? caller.guestId : c.get("org").id;
    const open = streams.get(who) ?? 0;
    if (open >= MAX_STREAMS_PER_CALLER) throw new ApiError("rate_limited", "Too many live connections.");
    streams.set(who, open + 1);

    // Bun closes a quiet connection after 10 seconds unless told otherwise.
    (c.env as { timeout?(request: Request, seconds: number): void } | undefined)?.timeout?.(c.req.raw, 0);
    const encoder = new TextEncoder();
    let finish = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => controller.enqueue(encoder.encode(text));
        const unsubscribe = deps.events.subscribe(resource.id, ({ type, data }) => {
          write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        const heartbeat = setInterval(() => write(": ok\n\n"), HEARTBEAT_MS);
        const limit = setTimeout(() => {
          finish();
          controller.close();
        }, STREAM_MS);
        let done = false;
        finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
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
