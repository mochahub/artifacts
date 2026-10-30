import { describe, expect, test } from "bun:test";
import { live, watchEvents } from "./events.ts";

class FakeSource {
  static last: FakeSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, () => void>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
}
const open = (onChange: (type: string) => void) =>
  watchEvents("a b", onChange, FakeSource as unknown as typeof EventSource);

describe("the event stream", () => {
  test("is live while open and passes each event type on", () => {
    const seen: string[] = [];
    const stop = open((type) => seen.push(type));
    expect(FakeSource.last.url).toBe("/api/events?artifact=a%20b");
    FakeSource.last.onopen?.();
    expect(live.value).toBe(true);
    FakeSource.last.listeners.get("thread")?.();
    FakeSource.last.listeners.get("version")?.();
    expect(seen).toEqual(["thread", "version"]);
    stop();
    expect(live.value).toBe(false);
    expect(FakeSource.last.closed).toBe(true);
  });

  test("the first open asks for nothing; a reconnect refreshes what it missed", () => {
    const seen: string[] = [];
    open((type) => seen.push(type));
    FakeSource.last.onopen?.();
    expect(seen).toEqual([]);
    FakeSource.last.onerror?.();
    expect(live.value).toBe(false);
    FakeSource.last.onopen?.();
    expect(live.value).toBe(true);
    expect(seen).toEqual(["reconnect"]);
  });
});
