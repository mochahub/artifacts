import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CACHES, TAPPED } from "./notify.ts";
import { articleUrl, renderUrl, safeNext } from "./paths.ts";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://art.test";

/** Runs the worker's file against a stand-in for its global scope. */
function load(windows: unknown[] = [], network = async (_: unknown) => new Response("{}")) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const shown: { title: string; options: { body?: string; data: { url: string } } }[] = [];
  const opened: string[] = [];
  const kept: string[] = [];
  const keptIn: string[] = [];
  const deleted: string[] = [];
  const fetched: string[] = [];
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
    open: async (name: string) => ({
      match: async () => undefined,
      put: async (request: Request | string) => {
        kept.push(typeof request === "string" ? request : new URL(request.url).pathname);
        keptIn.push(name);
      },
      keys: async () => [],
      delete: async () => true,
      add: async () => {},
    }),
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  };
  const fetch = (request: unknown) => {
    fetched.push(typeof request === "string" ? request : new URL((request as Request).url).pathname);
    return network(request);
  };
  new Function("self", "caches", "location", "fetch", source)(self, caches, { origin: ORIGIN }, fetch);

  /** Whether the worker took the request over, and what it kept. */
  const handles = async (path: string, destination = "") => {
    let responded: Promise<unknown> | null = null;
    const request = new Request(`${ORIGIN}${path}`);
    handlers.fetch?.({
      request: destination
        ? { url: request.url, method: "GET", headers: request.headers, mode: request.mode, destination }
        : request,
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
  const request = async (request: Request) => {
    let answer: Promise<Response> | undefined;
    handlers.fetch?.({
      request,
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
    });
    return answer;
  };
  return { handles, request, push, click, shown, opened, kept, keptIn, deleted, fetched };
}

describe("what the worker keeps", () => {
  test.each([
    "/api/librarian/config",
    "/api/librarian/runs",
    "/api/wikis/private/inbox",
    "/api/wikis/private/proposals/123",
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
    "/api/teams",
    "/api/teams/design",
    "/api/projects/checkout/access",
    "/api/people/search",
    "/api/artifacts/abc/teams/def",
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

// The worker is plain JavaScript served as it is, so it keeps its own copies of these. These tests tie
// each copy to the app's.
describe("what the worker shares with the app", () => {
  const id = "0b9f1e8c-1111-2222-3333-444444444444";
  const hash = "a".repeat(64);

  test("a lost artifact clears the caches the app clears at sign-out", async () => {
    const worker = load([], async () => new Response("", { status: 404 }));
    await worker.handles(`/api/artifacts/${id}`);
    expect(worker.deleted.sort()).toEqual([CACHES.api, CACHES.content].sort());
  });

  test("a tapped notification is left in the cache, under the key, that the app reads", async () => {
    const worker = load([{ postMessage: () => {}, focus: async () => {} }]);
    await worker.click("/camerabuddy/roadmap");
    expect(worker.kept).toEqual([TAPPED]);
    expect(worker.keptIn).toEqual([CACHES.shell]);
  });

  test.each(["/", "/p/a?c=2", "//evil.test", "/\\evil.test", "/\t/evil.test", "https://evil.test", "", 42])(
    "goes where sign-in would for %p",
    async (url) => {
      const worker = load();
      await worker.click(url);
      expect(worker.opened).toEqual([safeNext(typeof url === "string" ? url : undefined)]);
    },
  );

  test("keeps the renders the app shows, fetched the way a bucket allows", async () => {
    const worker = load();
    expect(await worker.handles(renderUrl(id, hash), "image")).toBe(true);
    expect(worker.fetched).toEqual([`${renderUrl(id, hash)}?via=app`]);
    expect(worker.keptIn).toEqual([CACHES.content]);
  });

  test("keeps the article HTML the app reads", async () => {
    const worker = load();
    expect(await worker.handles(articleUrl(id, 3, "plan"))).toBe(true);
    expect(worker.keptIn).toEqual([CACHES.content]);
  });
});

test("shared file is held in memory, consumed once, never cached or uploaded", async () => {
  const worker = load();
  const form = new FormData();
  form.set("title", "Private share");
  form.set("files", new File(["private mock text"], "note.txt", { type: "text/plain" }));
  const redirect = await worker.request(new Request(`${ORIGIN}/inbox/share`, { method: "POST", body: form }));
  expect(redirect?.status).toBe(303);
  const id = new URL(redirect?.headers.get("Location") ?? "").searchParams.get("share");
  const received = await worker.request(new Request(`${ORIGIN}/_librarian-share/${id}`));
  expect(received?.status).toBe(200);
  expect(received?.headers.get("Cache-Control")).toBe("no-store");
  if (!received) throw new Error("No share response");
  const shared = await received.formData();
  expect(await (shared.get("files") as File).text()).toBe("private mock text");
  expect((await worker.request(new Request(`${ORIGIN}/_librarian-share/${id}`)))?.status).toBe(410);
  expect(worker.kept).toEqual([]);
  expect(worker.fetched).toEqual([]);
});
