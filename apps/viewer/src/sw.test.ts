import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://art.test";

/** Runs the worker's file against a stand-in for its global scope. */
function load(windows: unknown[] = []) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const shown: { title: string; options: { body?: string; data: { url: string } } }[] = [];
  const opened: string[] = [];
  const kept: string[] = [];
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => unknown) => {
      handlers[type] = handler;
    },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
    registration: {
      showNotification: async (title: string, options: { body?: string; data: { url: string } }) => {
        shown.push({ title, options });
      },
    },
  };
  const caches = {
    open: async () => ({
      match: async () => undefined,
      put: async (request: Request | string) => {
        kept.push(typeof request === "string" ? request : new URL(request.url).pathname);
      },
      keys: async () => [],
      delete: async () => true,
      add: async () => {},
    }),
    delete: async () => true,
  };
  const network = async () => new Response("{}");
  new Function("self", "caches", "location", "fetch", source)(self, caches, { origin: ORIGIN }, network);

  /** Whether the worker took the request over, and what it kept. */
  const handles = async (path: string) => {
    let responded: Promise<unknown> | null = null;
    handlers.fetch?.({
      request: new Request(`${ORIGIN}${path}`),
      respondWith: (answer: Promise<unknown>) => {
        responded = answer;
      },
    });
    await responded;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return responded !== null;
  };
  const push = async (data: { json(): unknown } | undefined) => {
    const waits: Promise<unknown>[] = [];
    handlers.push?.({ data, waitUntil: (work: Promise<unknown>) => waits.push(work) });
    await Promise.all(waits);
  };
  const click = async (url: unknown) => {
    const waits: Promise<unknown>[] = [];
    handlers.notificationclick?.({
      notification: { close: () => {}, data: { url } },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
  };
  return { handles, push, click, shown, opened, kept };
}

describe("what the worker keeps", () => {
  test.each([
    "/api/people",
    "/api/people/3f1c",
    "/api/tokens",
    "/api/shares",
    "/api/org",
    "/api/invites/abc",
    "/api/reset/abc",
    "/api/device/WDJB-MJHT",
    "/api/me/sessions",
    "/api/me/passkeys",
    "/api/search",
    "/api/events",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/access",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/data/shared",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/data-export",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/files/me/a.png",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/logs",
  ])("leaves %s alone", async (path) => {
    const worker = load();
    expect(await worker.handles(path)).toBe(false);
    expect(worker.kept).toEqual([]);
  });

  test.each([
    "/api/me",
    "/api/home",
    "/api/projects",
    "/api/artifacts/by-slug/camerabuddy/roadmap",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/versions",
    "/api/artifacts/0b9f1e8c-1111-2222-3333-444444444444/threads",
  ])("keeps %s for offline", async (path) => {
    const worker = load();
    expect(await worker.handles(path)).toBe(true);
    expect(worker.kept).toEqual([path]);
  });
});

describe("push", () => {
  test("shows the message it was sent", async () => {
    const worker = load();
    await worker.push({ json: () => ({ title: "Claude replied", body: "On v3", url: "/p/a?c=2" }) });
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.title).toBe("Claude replied");
    expect(worker.shown[0]?.options.data.url).toBe("/p/a?c=2");
  });

  test.each([
    ["no data", undefined],
    [
      "data that isn't JSON",
      {
        json: () => {
          throw new SyntaxError("Unexpected token");
        },
      },
    ],
  ])("still shows a notification with %s", async (_, data) => {
    const worker = load();
    await worker.push(data);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.title).toBe("Artifacts");
  });

  test.each([
    "https://evil.test/",
    "//evil.test/",
    "/\\evil.test",
    "/ok\n//evil.test",
    "javascript:alert(1)",
    42,
  ])("opens the home page, not %p", async (url) => {
    const worker = load();
    await worker.click(url);
    expect(worker.opened).toEqual(["/"]);
  });

  test("opens a path on this site", async () => {
    const worker = load();
    await worker.click("/camerabuddy/roadmap/plan?c=2");
    expect(worker.opened).toEqual(["/camerabuddy/roadmap/plan?c=2"]);
  });

  test("leaves the path for an app that's already open, then wakes it", async () => {
    const steps: string[] = [];
    const app = {
      postMessage: (message: string) => steps.push(message),
      focus: async () => steps.push("focus"),
    };
    const worker = load([app]);
    await worker.click("/camerabuddy/roadmap/plan?c=2");
    expect(worker.opened).toEqual([]);
    expect(worker.kept).toEqual(["/tapped-notification"]);
    expect(steps).toEqual(["tapped", "focus"]);
  });
});
