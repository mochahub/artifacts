# Micro apps

An artifact can be pages, or a small app: a frontend, an optional backend and an optional data folder.

## The sandbox

A live frame or prototype runs in `<iframe sandbox="allow-scripts">`, without `allow-same-origin`, under a strict Content Security Policy. Its origin is `null`.

Lint reads the source, and `artifacts render` doesn't run a prototype, so most of what follows only shows up when the page runs. Test it with `artifacts dev`, which uses the real viewer, the same sandbox and the same policy. Open `/<project>/<slug>/<page>` on the link it prints, and watch the console. That link is only for your test. The data store works there too, but it never answers in an iframe of your own. Hand people the published link.

- **Storage:** `localStorage`, `sessionStorage`, `indexedDB` and `document.cookie` throw `SecurityError`. Lint refuses those words in your pages and scripts, even behind a guard or in a comment. Use the data store.
- **Canvas:** drawing a plain `<img>` taints the canvas, so `getImageData` and `toDataURL` throw `SecurityError`. Set `img.crossOrigin = "anonymous"` before `src`, or `fetch` the file and pass the blob to `createImageBitmap`.
- **History:** `replaceState` and `pushState` can change the query or the hash. Changing the path throws `SecurityError` in Safari but not in Chromium, so routers that use paths break on an iPhone. Wrap these calls in `try`.
- **URL:** the page always starts with no query or hash. Nothing in the viewer's URL reaches it. Don't put a query in `src`: lint passes, but the viewer encodes the `?` into the file name and the page isn't found.
- **Network:** scripts, styles, fonts, images and `fetch` load only from the artifact's own files. Other hosts are blocked, so ship what you need in the bundle.
- **Files:** only files named by a page, a stylesheet, an import or a `fetch("literal")` get published. A path built in JavaScript isn't found, so name those files in the HTML too.
- **Code:** `eval`, `new Function`, WebAssembly, workers and service workers fail. Compile before you publish; a compiler running in the browser won't work.
- **Dialogs and forms:** `alert` does nothing and `confirm` returns `false`. `window.open` returns `null`. A form never submits, so handle `submit` in JavaScript and call `preventDefault()`.
- **Layout:** the viewer's capsule sits above the frame, not over it. On a phone the frame starts 74 px down, plus the top safe area, and runs to the bottom edge, so a 390 × 844 screen gives 390 × 770. It's at most 480 px wide, and `100vh` means the frame's height. The viewer draws no device around a prototype.
- **Time:** the frame's files stop loading 2 hours after it opens, until the viewer reloads it. Load what you need up front.
- **Comments:** a prototype page has no comments. Add an article, or a canvas of its key screens, so reviewers have somewhere to pin them.

## The data store

Use it from a live frame or prototype. Never use `localStorage`, cookies or your own server.

```js
import { data } from "./vendor/artifacts-kit/data.js";

const { value, etag } = (await data.shared.get("votes")) ?? { value: {} };
await data.shared.put("votes", next, { ifMatch: etag });
await data.shared.update("votes", (v) => ({ ...v, a: 1 }));
await data.me.put("draft", { schema: 1, text });
for await (const key of data.me.list("todos/")) console.log(key);
```

- `shared` is one copy for everyone. `me` is one copy per person.
- Values are JSON, up to 64 KB. Keys use `A-Za-z0-9._/-`.
- `data.me.files.put(name, blob)`, `.url(name)`, `.list()` and `.delete(name)` store files.
- Keep a `schema` number in stored values, because data outlives versions.

**Fixtures** feed renders, so pictures don't depend on what reviewers clicked: `fixtures/data.json` is `{ "shared": {...}, "me": {...} }`.

## Backends

Add one only when the store isn't enough, such as hiding votes until everyone has voted.

```ts
// api/index.ts
import { caller } from "../vendor/artifacts-kit/backend.js";

export default {
  async fetch(request, env) {
    const who = caller(request); // { id, name, kind, canComment, isPublisher }
    const votes = (await env.DATA.get("votes")) ?? {};
    if (request.method === "POST") {
      votes[who.id] = (await request.json()).choice;
      await env.DATA.put("votes", votes);
    }
    return Response.json(votes);
  },
};
```

Declare it with `"backend": { "src": "api/index.ts" }`, and call it from the frontend with a relative URL: `fetch("api/votes")`.

A backend has only `env.DATA`. It has no network, timers, file system or secrets, and gets 10 seconds and 64 MB. Writes are refused for people who can only view. `artifacts logs` shows its console output.
