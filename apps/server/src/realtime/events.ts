import postgres from "postgres";
import { findArtifact, isUuid } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import type { ApiContext, Routes } from "../api/routes.ts";
import { callerKey } from "../data/store.ts";
import { ApiError } from "../http/errors.ts";

export type EventType = "thread" | "comment" | "version" | "decision" | "data";
type Message = { artifact: string; type: EventType; data: Record<string, unknown> };

const CHANNEL = "artifacts_events";
const PING = "ping";
const PING_MS = 30_000;
const HEARTBEAT_MS = 25_000;
/** Closing often means access is checked again on each reconnect, by the same guard as anything else. */
const STREAM_MS = 5 * 60_000;
const MAX_STREAMS_PER_CALLER = 10;

/** Events hold no content, only that something changed, so a caller fetches it through its own access. */
export class Events {
  private readonly listeners = new Map<string, Set<(message: Message) => void>>();
  private readonly streams = new Set<() => void>();
  private client: postgres.Sql;
  private timer: Timer | null = null;
  private heard = Date.now();

  constructor(
    private readonly url: string,
    private readonly pingMs = PING_MS,
  ) {
    this.client = this.connect();
  }

  private connect() {
    return postgres(this.url, { max: 1, onnotice: () => {} });
  }

  private listen() {
    return this.client.listen(CHANNEL, (payload) => {
      this.heard = Date.now();
      const message = JSON.parse(payload) as Message;
      for (const listener of this.listeners.get(message.artifact) ?? []) listener(message);
    });
  }

  /**
   * Fans out across replicas (03). Waits for LISTEN, so no event sent after boot is missed. It pings
   * itself too: after an outage the driver can give up on LISTEN silently, and open streams would look
   * healthy while hearing nothing. A lost listener reconnects and closes them, so browsers catch up.
   */
  async start() {
    await this.listen();
    this.timer = setInterval(() => {
      this.emit(PING, "data");
      if (Date.now() - this.heard > this.pingMs * 3) this.reconnect().catch(() => {});
    }, this.pingMs);
    this.timer.unref();
  }

  private async reconnect() {
    const old = this.client;
    this.client = this.connect();
    this.heard = Date.now();
    old.end({ timeout: 1 }).catch(() => {});
    await this.listen();
    for (const close of [...this.streams]) close();
  }

  /** Called when the listener was lost, so a stream can end and be reopened. */
  onLost(close: () => void) {
    this.streams.add(close);
    return () => this.streams.delete(close);
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
    if (this.timer) clearInterval(this.timer);
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
    // An org token has no person, so it counts by itself rather than with every other one.
    const who = callerKey(caller) ?? ("tokenId" in caller ? caller.tokenId : c.get("org").id);
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
        const end = () => {
          finish();
          controller.close();
        };
        const limit = setTimeout(end, STREAM_MS);
        const forget = deps.events.onLost(end);
        let done = false;
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
