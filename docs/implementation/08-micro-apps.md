# 08 · Micro apps: Try it, the data store and backends

**Contract document** for the frame↔viewer message protocol, the data store's server rules and limits, and the backend sandbox. Behaviour comes from SPEC §7.9. Phase 2, but the data model (02) and permissions (04) already account for it.

## The parts

| Part | Package | Runs in |
|---|---|---|
| `@artifacts/kit/data` | `packages/kit/src/data.js`, vendored by `artifacts init` as `vendor/artifacts-kit/data.js` | The artifact's frontend, inside the sandboxed iframe |
| The bridge | `apps/viewer/src/live/bridge.ts` | The viewer page, the iframe's parent |
| Data store | `apps/server/src/data/` | The app: the data API (03), and `env.DATA` for backends |
| Backend proxy | `apps/server/src/content/proxy.ts` | The app, content port: `/t/<token>/v<n>/api/*` |
| Sandbox | `packages/sandbox/` (child, prelude, parent side) and `apps/server/src/sandbox/pool.ts` | Child processes of the app: QuickJS in WebAssembly, one instance per backend |
| `@artifacts/kit/backend` | `packages/kit/src/backend.js` | Inside the artifact's backend (`caller()`, types for `Env`) |

## Try it

- **Where:** a canvas frame with `live_path`, or any `prototype` page, offers **Try it**.
- **What the viewer does:**
  1. Mints a content token (`POST /api/artifacts/:id/content-token`).
  2. Replaces the frame image with `<iframe sandbox="allow-scripts" src="<base><live_path>">` at the frame's size and device scale.
  3. Starts the bridge for that iframe.
- **Done:** removes the iframe and puts the image back.
- **One at a time:** only one live iframe at a time on phones; two on desktop.
- **Notice:** the first time a frame reads or saves data, a one-line notice shows: "Saved for everyone" or "Saved for you", and "Its author can see what's saved".

## The bridge

The frame has an opaque origin: no cookies, no storage, and cross-origin `fetch` to the API would need credentials it doesn't have. So the kit asks the parent window.

**Messages** (structured clone; `Blob`s allowed):

```ts
// frame → viewer
type Req = { artifacts: 1, id: string /* random */, op:
  | { kind: "get", scope: "shared"|"me", key: string }
  | { kind: "list", scope, prefix?: string, cursor?: string }
  | { kind: "put", scope, key, value: Json, ifMatch?: string | "*" /* "*" = only if new */ }
  | { kind: "delete", scope, key, ifMatch?: string }
  | { kind: "file.put", scope, name: string, blob: Blob }
  | { kind: "file.url", scope, name }
  | { kind: "file.list", scope }
  | { kind: "file.delete", scope, name }
  | { kind: "whoami" } };                     // → { name, kind, canWrite }
// viewer → frame
type Res = { artifacts: 1, id: string, ok: true, result: unknown }
         | { artifacts: 1, id: string, ok: false, error: { code: "precondition_failed"|"read_only"|"too_large"|"forbidden"|"not_found"|"rate_limited"|"invalid", message: string } };
```

**Viewer rules:**
1. **Check the sender:** accept a message only if `event.source` is set and `=== liveIframe.contentWindow` for the iframe it created (a closed sender has a null source, and a detached iframe a null window, which would otherwise match), and `event.data.artifacts === 1`. `event.origin` is the string `"null"` for opaque origins, so the source check is what matters.
2. **Bind to the iframe:** the artifact id and version come from the iframe's own record in the viewer, never from the message.
3. **Map to the API:** translate the op to the data API (03) with the viewer's own credentials (session or guest cookie), and post the result back to `event.source` with `targetOrigin "*"`. The data is the frame's own, so nothing leaks.
4. **Limit:** cap in-flight requests at 8 per frame and drop the rest with `rate_limited`.

**Kit API** (`@artifacts/kit/data`): `data.shared` and `data.me`, each with:
- `get(key)` → `{ value, etag } | null`
- `put(key, value, { ifMatch })`, which throws `Conflict` on 412
- `update(key, fn, { retries: 5 })`
- `delete(key)`
- `list(prefix)` (async iterator)
- `files.put(name, blob)`, `files.url(name)`, `files.list()`, `files.delete(name)`

`data.whoami()` → `{ name, kind, canWrite }`.

**Outside the viewer:**
- **During `artifacts render`:** the kit reads `window.__ARTIFACTS_FIXTURES__`, and writes are no-ops.
- **In `artifacts dev`:** the dev server's viewer runs the same bridge against the local store.

## Data store (server)

**Paths:** `data/<artifact id>/<scope path>/<key>` (02).
- `<scope path>` is `shared` or `me/<caller id>` for the public API.
- Through `env.DATA`, a backend can address `shared`, `me/<any id>` or `files/...`.

**Reads:**
- `GetObject`. The ETag is the bucket's ETag, quotes stripped.
- `list` is `ListObjectsV2` with a prefix and a continuation token; at most 1000 keys per page.

**Writes:**
1. Check the caller can write and the artifact isn't archived. Archived returns `read_only`, from the API and from `env.DATA`.
2. Check the value and key sizes and the `writesPerSecond` limit (default 10).
3. In one Postgres transaction, lock the `artifact_usage` row for `(artifact, scope)` (`SELECT … FOR UPDATE`; 02), `HeadObject` the key for its current size, compute the new key count and bytes, and refuse with `too_large` if over the limits.
4. `PutObject` with `If-Match: <etag>` (from the client), or `If-None-Match: *` for create-only. With no precondition, the write is unconditional (last write wins). A 412 from the bucket is returned to the client as 412. `If-Match` on a key that doesn't exist is also 412: buckets that pass spike S3 answer 404, and the app maps it to 412.
5. Update the usage row and commit. Writes to one artifact's scope are serialized by the row lock, which is fine at these limits. If the process dies between 4 and 5, the daily job recounts usage for artifacts written that day.

Conditional writes are required of the bucket. Railway's bucket and SeaweedFS both pass (spike S3), so there's no lock-only fallback.

**Limits** (`org.settings.limits`; admins can raise them):

| Limit | Default |
|---|---|
| `dataValueBytes` | 64 KB per JSON value |
| `dataKeysPerScope` | 1,000 keys per scope per artifact |
| `dataBytesPerScope` | 5 MB per scope per artifact |
| `fileBytes` | 10 MB per file |
| `filesBytesPerArtifact` | 100 MB |
| `writesPerSecond` | 10 per caller per artifact |
| `backendCodeBytes` | 1 MB |
| `backendTimeoutMs` | 10,000 |
| `backendMemoryMb` | 64 (the WebAssembly memory maximum per backend) |
| `backendRequestBytes` | 1 MB |
| `backendResponseBytes` | 5 MB |
| `backendRequestsPerMinute` | 120 per caller per artifact |

**Files:**
- **Uploads:** the app streams the body to `PutObject` with the declared `Content-Type`.
- **Downloads:** presigned GET with `response-content-type`. Types other than `image/*`, `audio/*`, `video/*` and `application/pdf` are also given `response-content-disposition=attachment`.

**Export and clear:**
- `data-export` walks the prefix and resolves `me/<id>` to names (people and `guest_links`).
- `data-clear` deletes the prefix (or one scope) and resets usage.

## Request flow

```
iframe (opaque origin)  fetch("api/votes")            →  <content>/t/<tok>/v5/api/votes
content port            verify token; version 5 has backend_hash H; artifact not deleted;
                        rate limit; body ≤ backendRequestBytes
                        caller = from the token (pseudonym, name, kind, canComment, isPublisher)
                        scope  = { artifactId, readOnly: archived || !caller.canComment }   ← kept in the app
                        →  sandbox.run(H, request, caller)            (IPC to a sandbox process)
sandbox process         instance = warm.get(H) ?? load(code for H, sent by the app)
                        response = await instance.fetch(request', env)   // env.DATA is the only binding
                        env.DATA.put(…)  →  IPC to the app  →  the app applies `scope` and calls the bucket
                        →  back to the app (≤ backendResponseBytes)  →  back to the iframe (Access-Control-Allow-Origin: *)
```

- **Identity:** the app builds the request the sandbox sees: method, path after `api/`, the body, `Content-Type`, and an `X-Caller` header set by the app. It never forwards cookies, and drops any `X-Caller` the client sent.
- **`caller(request)`** in `@artifacts/kit/backend` parses `X-Caller`: `{ id, name, kind: "member"|"reviewer"|"outside"|"guest"|"admin"|"owner", canComment, isPublisher }`.
  - `id` is a per-artifact pseudonym: HMAC(`org.pseudonym_key`, `artifactId + ":" + personOrGuestId`), first 16 bytes, base32. It's stable within the artifact and differs across artifacts. The key is generated at setup and kept in Postgres (02), separate from `SESSION_SECRET`, so `SESSION_SECRET` can be rotated.
  - The data store's `me/<id>` uses the **same pseudonym**, so a backend and the built-in store agree on who's who. The export maps pseudonyms back to names for the publisher.
- **Read-only by default for viewers:** `env.DATA` writes are refused with `read_only` when the artifact is archived **or the caller can't comment** (for example, a guest on a view-only link). A backend can't widen this.
- **Scope is the app's, never the sandbox's:** every `env.DATA` call over IPC carries only the request id. The app looks up the artifact and the read-only flag it recorded for that request, and refuses calls for requests that aren't in flight.

## Backends: the sandbox (`apps/server/src/sandbox/`)

Backends run in **QuickJS compiled to WebAssembly** (`quickjs-emscripten`, pinned), in **child processes of the app**. Chosen 2026-10-30 after spike S4 ([spikes.md](spikes.md#s4--workerd-worker-loader)): workerd and Deno couldn't enforce per-backend CPU and memory limits, and this can, with no extra service.

| File | Runs in | Does |
|---|---|---|
| `pool.ts` | The app | Starts and supervises the sandbox processes, routes requests, answers `env.DATA` calls and writes logs |
| `packages/sandbox/src/child.js` | Each sandbox process | Holds QuickJS instances and runs requests |

**Processes:**
- The app starts `sandboxProcesses` children (default 2) with `Bun.spawn([process.execPath, child.js], { env: {}, ipc })`. The environment is **empty**: a child never has the database URL, bucket keys, `SESSION_SECRET` or `OPS_SECRET`. Its only channel is IPC to the app.
- If a child exits, its in-flight requests answer 502 and the app starts a new one.

**Instances:**
- **One WebAssembly instance per artifact and backend hash**, so two artifacts with the same code share nothing, created with its own `WebAssembly.Memory` whose maximum is `backendMemoryMb`; QuickJS's own limit is set 8 MB below that, and the stack to 512 KB. Never the shared `getQuickJS()` instance: a QuickJS bug in one backend must not be able to read another's memory.
- **The code** is the bundled backend: one ES module with no imports, built by the CLI (05). The sandbox evaluates it as a module and refuses any `import`. The app sends it to the child by hash on first use.
- **What the sandbox has:** the JavaScript language, small `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `TextEncoder` and `TextDecoder` (`packages/sandbox/src/prelude.js`, loaded before the backend), `console`, and `env.DATA`:
  - `get(key)` → the value or `null`; `getWithEtag(key)` → `{ value, etag } | null`
  - `put(key, value, { ifMatch })` → `{ etag }`; `ifMatch: "*"` means only if new
  - `delete(key, { ifMatch })`; `list(prefix, { cursor })` → `{ keys, nextCursor }`
  - A key with no scope means `shared/<key>`.
  - At most 8 calls run at once and the rest wait, 200 per request. Writes also count against `writesPerSecond`. Calls after the response are refused, and an instance that answers with calls still out is replaced, so its work can't carry on under the next caller.
  No `fetch`, sockets, timers, file system, environment or module loading.
- **Warm cache:** up to 16 instances per child (least recently used), and an instance idle for 10 minutes is discarded.

**Limits, enforced per request:**
- **Time:** a wall-clock deadline of `backendTimeoutMs` from when the request starts running (queue time doesn't count). QuickJS's interrupt handler enforces it while code runs, top-level code on load included; the app enforces it while the backend awaits `env.DATA`. On timeout: 504, and the instance is discarded.
- **Memory:** an allocation past the limit throws "out of memory" inside the backend. The request answers 500 and the instance is discarded. **After every request**, an instance whose WebAssembly memory has grown past half of `backendMemoryMb` is discarded too, because WebAssembly memory never shrinks.
- **Logs:** 100 lines per request, 8 KB per line, and 1 MB per artifact per minute. Past that, lines are dropped.
- **Headers:** only `content-type`, `etag` and `last-modified` pass, and `Cache-Control` is always `no-store`, because an answer can hold one caller's data.
- **One at a time:** each backend is pinned to one child by its hash, and its requests run one at a time (QuickJS is synchronous, and one instance has one deadline). At most 4 requests wait per backend and 32 per child; beyond that, 503 `busy`.
- **Sizes:** request bodies over `backendRequestBytes` get 413 before reaching the sandbox; responses over `backendResponseBytes` get 502.
- **Teardown:** freeing an instance with `env.DATA` calls in flight makes emscripten abort, which is catchable and leaves only that instance dead (checked in M10, `spikes/s10/`). So freeing is tried, a failure is ignored, and the instance is dropped; its own `WebAssembly.Memory` goes with it. Late `env.DATA` answers for it are ignored.

Checked before building (M10, `spikes/s10/`): `Bun.spawn` with `ipc` and an empty environment works, and the child sees no variables; a second child answers in 37 ms while the first runs a busy loop, which is then interrupted on time; freeing mid-call aborts emscripten, the abort is catchable, and the same child runs the next request; typed-array, string and heap floods and deep recursion all fail inside the backend and leave the child alive; a crashed child's exit reaches the parent.

**Logs:** `console.*` lines go to the app over IPC, at most 100 per request and 8 KB each (02 `backend_logs`), with uncaught errors. `artifacts logs` reads them.

**Threat model:** everyone who can publish is invited (SPEC §7.9). The boundary is WebAssembly memory safety in Bun's engine. The child process is a second layer: an escape from the engine still reaches nothing but the IPC channel, whose every call the app checks against the request in flight. A hosted, multi-tenant version would need a VM per tenant.

## Local development

- **`artifacts dev`:**
  - serves the viewer and content host on `localhost`
  - runs the bridge against `.artifacts/data/` (same layout as the bucket prefix, without `data/<id>/`)
  - runs backends in the same sandbox, from the CLI's helper folder (`quickjs-emscripten` is installed there with Playwright; 07), with `env.DATA` backed by the local folder, reloaded on change
- **`artifacts render`:** runs the backend the same way against the fixtures for rendering.
