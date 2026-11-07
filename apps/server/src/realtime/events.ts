import type { EventType } from "@artifacts/schema";
import postgres from "postgres";

type Message = { artifact: string; type: EventType; data: Record<string, unknown> };

const CHANNEL = "artifacts_events";
const PING = "ping";
const PING_MS = 30_000;
const HEARTBEAT_MS = 25_000;

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
    readonly heartbeatMs = HEARTBEAT_MS,
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
    const client = this.connect();
    this.client = client;
    this.heard = Date.now();
    old.end({ timeout: 1 }).catch(() => {});
    await this.listen();
    // Every few pings of an outage starts another attempt, and when it ends several can land at once.
    if (client !== this.client) return;
    this.heard = Date.now();
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
