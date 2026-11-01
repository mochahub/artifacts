// The service worker (06). Versions never change, so what's been opened is kept and works offline.
const SHELL = "shell-v1";
const CONTENT = "content-v1";
const API = "api-v1";
const MAX_CONTENT = 1500;
const MAX_API = 300;

// These change with the session, are a stream, or aren't worth keeping. The lists of people, teams,
// tokens, invites and who an artifact is shared with are never kept: they name other people, and a
// worker's answer isn't tied to whoever asked.
const NEVER =
  /^\/api\/(?:events|auth|me\/|push|health|search|tokens|people|teams|shares|org|invites|reset|device|recover|setup|publish|deleted|artifacts\/[^/]+\/(?:access|teams|data|data-export|files|logs|content-token)(?:\/|$))/;
const ASSETS = /^\/assets\//;
const RENDER = /^\/api\/artifacts\/[^/]+\/r\/[0-9a-f]{64}$/;
const ARTICLE = /^\/api\/artifacts\/[^/]+\/v\/\d+\//;
// A refusal on these means this device has lost the artifact, so what it kept goes too.
const ACCESS = /^\/api\/(artifacts\/(by-slug\/[^/]+\/[^/]+|[0-9a-f-]{36})|s\/[^/]+|me)$/;

const forget = () => Promise.all([API, CONTENT].map((name) => caches.delete(name)));

/** Never fails a page: a full disk means something isn't kept, not that it isn't shown. */
const keep = async (name, request, response, limit) => {
  try {
    const cache = await caches.open(name);
    await cache.put(request, response);
    if (!limit) return;
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((key) => cache.delete(key)));
  } catch {}
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add("/"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const cacheFirst = async (request, name, limit, fetchFrom = request) => {
  const hit = await (await caches.open(name)).match(request);
  if (hit) return hit;
  const response = await fetch(fetchFrom);
  if (response.ok) keep(name, request, response.clone(), limit);
  return response;
};

const networkFirst = async (request, url) => {
  try {
    const response = await fetch(request);
    if (response.ok) keep(API, request, response.clone(), MAX_API);
    else if ([401, 403, 404, 410].includes(response.status) && ACCESS.test(url.pathname)) await forget();
    return response;
  } catch (error) {
    const hit = await (await caches.open(API)).match(request);
    if (hit) return hit;
    throw error;
  }
};

const page = async (request) => {
  try {
    const response = await fetch(request);
    // The same page for every address, so the offline copy follows each deploy.
    if (response.ok) keep(SHELL, "/", response.clone());
    return response;
  } catch {
    return (await caches.open(SHELL)).match("/");
  }
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  // Video and audio ask for ranges, which a whole-file cache can't answer.
  if (request.headers.has("range") || NEVER.test(url.pathname)) return;
  if (request.mode === "navigate") event.respondWith(page(request));
  else if (ASSETS.test(url.pathname)) event.respondWith(cacheFirst(request, SHELL));
  else if (RENDER.test(url.pathname) && request.destination === "image") {
    event.respondWith(cacheFirst(request, CONTENT, MAX_CONTENT, `${url.pathname}?via=app`));
  } else if (ARTICLE.test(url.pathname)) event.respondWith(cacheFirst(request, CONTENT, MAX_CONTENT));
  else if (url.pathname.startsWith("/api/")) event.respondWith(networkFirst(request, url));
});

// Safari drops a subscription whose push shows nothing, so even an unreadable one shows something.
const readPush = (event) => {
  try {
    return event.data?.json() ?? {};
  } catch {
    return {};
  }
};

// Only a path on this site: the address came over the network, and openWindow would follow any.
const ownPath = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\s]/.test(value)
    ? value
    : "/";

self.addEventListener("push", (event) => {
  const message = readPush(event);
  event.waitUntil(
    self.registration.showNotification(message.title ?? "Artifacts", {
      body: message.body,
      tag: message.tag,
      icon: "/icon-192.png",
      data: { url: ownPath(message.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = ownPath(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windows) => {
      const open = windows.find((client) => "navigate" in client);
      return open ? open.focus().then(() => open.navigate(url)) : self.clients.openWindow(url);
    }),
  );
});
