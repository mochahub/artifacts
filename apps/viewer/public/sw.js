// The service worker (06). Versions never change, so what's been opened is kept and works offline.
const SHELL = "shell-v1";
const CONTENT = "content-v1";
const API = "api-v1";

// These change hands with the session, or are a stream, so they never go through the cache.
const NEVER = /^\/api\/(events|auth|me\/|push|health)/;
const IMMUTABLE = /^\/(assets\/|api\/artifacts\/[^/]+\/(r\/[0-9a-f]{64}|v\/\d+\/))/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add("/"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const cacheFirst = async (request) => {
  const cache = await caches.open(CONTENT);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // A render redirects to the bucket, so its answer can be opaque; it's still immutable.
  if (response.ok || response.type === "opaque" || response.type === "opaqueredirect") {
    await cache.put(request, response.clone());
  }
  return response;
};

const networkFirst = async (request, name) => {
  const cache = await caches.open(name);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    // Signed out or removed: nothing kept here is theirs to read any more.
    if (response.status === 401) await Promise.all([API, CONTENT].map((key) => caches.delete(key)));
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (NEVER.test(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.open(SHELL)).match("/")));
  } else if (IMMUTABLE.test(url.pathname)) event.respondWith(cacheFirst(request));
  else if (url.pathname.startsWith("/api/")) event.respondWith(networkFirst(request, API));
});

self.addEventListener("message", (event) => {
  if (event.data === "clear") {
    event.waitUntil(Promise.all([API, CONTENT].map((key) => caches.delete(key))));
  }
});

self.addEventListener("push", (event) => {
  const message = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(message.title ?? "Artifacts", {
      body: message.body,
      tag: message.tag,
      icon: "/icon-192.png",
      data: { url: message.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windows) => {
      const open = windows.find((client) => "navigate" in client);
      return open ? open.focus().then(() => open.navigate(url)) : self.clients.openWindow(url);
    }),
  );
});
