import { afterEach, describe, expect, test } from "bun:test";
import { followTapped, tapped } from "./notify.ts";

const original = globalThis.caches;
afterEach(() => {
  globalThis.caches = original;
});

/** Stands in for the cache the worker leaves its note in. */
function leave(note: unknown) {
  let body = note === undefined ? null : JSON.stringify(note);
  globalThis.caches = {
    open: async () => ({
      match: async () => (body === null ? undefined : new Response(body)),
      delete: async () => {
        const had = body !== null;
        body = null;
        return had;
      },
    }),
  } as unknown as CacheStorage;
}

const follow = async () => {
  const went: string[] = [];
  await followTapped((url) => went.push(url));
  return went;
};

describe("a tapped notification", () => {
  test("goes where the worker said, once", async () => {
    leave({ url: "/camerabuddy/roadmap/plan?c=2", at: Date.now() });
    const before = tapped.value;
    expect(await follow()).toEqual(["/camerabuddy/roadmap/plan?c=2"]);
    expect(await follow()).toEqual([]);
    expect(tapped.value).toBe(before + 1);
  });

  test("goes once when two wake-ups race", async () => {
    leave({ url: "/activity", at: Date.now() });
    const went: string[] = [];
    await Promise.all([1, 2].map(() => followTapped((url) => went.push(url))));
    expect(went).toEqual(["/activity"]);
  });

  test("doesn't move a page for a tap from a while ago", async () => {
    leave({ url: "/activity", at: Date.now() - 120_000 });
    expect(await follow()).toEqual([]);
  });

  test("stays on this site", async () => {
    leave({ url: "//evil.test/", at: Date.now() });
    expect(await follow()).toEqual(["/"]);
  });

  test("does nothing with no note, and where there's no cache", async () => {
    leave(undefined);
    expect(await follow()).toEqual([]);
    globalThis.caches = undefined as unknown as CacheStorage;
    expect(await follow()).toEqual([]);
  });
});
