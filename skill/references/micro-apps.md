# Micro apps

An artifact can be pages, or a small app: a frontend, an optional backend and an optional data folder.

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
import { caller } from "./vendor/artifacts-kit/backend.js";

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
