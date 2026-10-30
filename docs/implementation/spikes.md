# Spike results (M0)

Results of the verification spikes in [11-milestones.md](11-milestones.md#m0--verification-spikes). Each says what was tried, what happened, and what changes in the design. The scripts are in `spikes/` at the repo root, and each one can be run again.

**Run on 2026-10-29**, on macOS 27.0.1 (arm64), with Docker 28.0.4 for the Linux runs (linux/arm64 native, linux/amd64 emulated).

| Tool | Version |
|---|---|
| Bun | 1.4.2 (`oven/bun:1.4.2`, `oven/bun:1.4.2-slim`) |
| playwright-core | 1.64.1 (WebKit 27.2, build 2370) |
| sharp | 0.35.5 |
| @aws-sdk/client-s3 | 3.1160.0 |
| workerd | 1.20261030.1 (`workerd 2026-10-30`) |
| Deno | 2.9.8 |
| Codex CLI | 0.166.0 |
| Railway CLI | 5.71.0 |
| S3 servers | MinIO `RELEASE.2025-06-13T11-33-47Z` (last image, cached locally), SeaweedFS 4.50, RustFS 1.0.4 |

## Summary

| Spike | Result | Changes the design? |
|---|---|---|
| S1 Railway provisioning | **Mostly passes** on Railway (2026-10-30): three generated domains on one service, `${{secret()}}`, bucket and Postgres references, private hostnames. `RAILWAY_PUBLIC_DOMAIN` holds only the first domain. Template creation and `deploy --template` wait for M8. | Small: 09 (how `CONTENT_URL` is set) |
| S2 Passkeys across domains | **Passes** on the user's iPhone (2026-10-30): a passkey made for the home domain signed in on a second Railway domain via `/.well-known/webauthn` | No: SPEC §7.3 stands |
| S3 Conditional writes | **Passes** on SeaweedFS and RustFS. MinIO is **no longer distributed**; **SeaweedFS chosen**. **Railway's bucket passes 22/22** in both URL styles. | Yes: SeaweedFS in Compose, and one S3 client setting |
| S4 Backend runner | workerd and Deno both **fail on limits**. **QuickJS (WebAssembly) inside the app passes everything** | Yes: **decided 2026-10-30**, QuickJS in child processes of the app replaces the runner service |
| S5 Compiled Bun CLI | **Passes**, with one change: sharp runs in a helper, not inside the binary | Small: 07 updated |
| S6 Runner wake on Railway | **Passes**: a private-network request woke the sleeping runner in about 1.0 s, with no 502 (one sample). Moot if the QuickJS recommendation is taken. | — |
| S7 Codex skills folder | **Passes**: `${CODEX_HOME:-~/.codex}/skills/` | 07 updated |
| S8 Live frames in WebKit | **Passes** with the CSP and CORS in 03 | 03 updated with the confirmed details |

## S3 · Conditional writes and presigned URLs

**Script:** `spikes/s3-conditional.ts` (22 checks; the same script runs against Railway's bucket).

**MinIO is gone.** The `minio/minio` image no longer exists on Docker Hub or Quay, and the `minio/minio` GitHub repository is archived (last push 2026-04-24). 09 and 01 name `minio/minio` for Compose, dev and tests, and a new user couldn't pull it. The last image was still cached on this machine, so it was tested as well. Two maintained, Apache-2.0, S3-compatible servers were tested alongside it:

| Check | MinIO (2025-06, last image) | SeaweedFS 4.50 | RustFS 1.0.4 |
|---|---|---|---|
| `If-None-Match: *` on a new key, then again (412) | ✓ | ✓ | ✓ |
| `If-Match` current ETag (quoted and unquoted); stale ETag (412) | ✓ | ✓ | ✓ |
| `If-Match` on a key that doesn't exist | ✗ **creates it** | ✓ 404 | ✓ 404 |
| 10 concurrent creates, and 10 concurrent `If-Match` updates: exactly one wins, the rest get 412 | ✓ | ✓ | ✓ |
| `DeleteObject` with a wrong `If-Match` is refused | ✗ **deletes anyway** | ✓ 412 | ✓ 412 |
| Presigned PUT with signed `Content-Type`, `Content-Length` and `Cache-Control`; wrong type or length gets 403; the stored object keeps both headers | ✓ | ✓ (with the client setting below) | ✓ |
| Presigned GET signed at 00:00 UTC is identical all day and works with a 26 h expiry; `response-content-type` and `response-content-disposition` overrides; conditional GET gets 304 | ✓ | ✓ | ✓ |
| **Total** | 20/22 | 22/22 | 22/22 |

**Finding: the S3 client's default checksums break presigned PUTs.** The AWS SDK (3.x, current) by default puts `x-amz-checksum-crc32` of an *empty* body into every presigned PUT URL. MinIO and RustFS ignore it, but SeaweedFS rejects the upload with `400 BadDigest`, and other servers (possibly Tigris, behind Railway's buckets) may too. The fix is to create the client with `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"`. Added to [05](05-publish-and-storage.md#presigned-urls).

**Finding: don't rely on the bucket for `If-Match` on a missing key.** A bucket may answer 404 or create the key. The data store maps a 404 on a conditional write to 412, and treats `If-Match` on a key that doesn't exist as 412 without writing. Added to [08](08-micro-apps.md#data-store-server).

**Decision needed: what replaces MinIO in Compose, dev and tests.** Both alternatives passed everything:
- **SeaweedFS** (Apache 2.0, maintained since 2015, very widely deployed). It runs as one container (`weed server -s3`) and needs a small JSON file for keys.
- **RustFS** (Apache 2.0, 1.0 in 2026). It's a near drop-in for MinIO: the same keys-by-environment setup and a web console. It's younger.

**Decided (2026-10-29): SeaweedFS**, pinned to `chrislusf/seaweedfs:4.50` (multi-arch). SPEC §7, §7.6, §7.9 and §11, and 05, 07, 09, 10 and 11 now say SeaweedFS.

**Railway half:** passed 22/22 on 2026-10-30, in both URL styles ([results below](#s1-s3-and-s6-on-railway-run-2026-10-30)). Whether Safari keeps presigned GETs cached still needs a real iPhone (progress.md, "Needs you").

## S4 · workerd worker loader

**Scripts:** `spikes/s4/` (workerd config, loader, data and log workers, and `run.ts`, which runs a mock internal API and the tests), and `spikes/s4-deno/host.ts` for the fallback.

**What works:**

| Question | Result |
|---|---|
| Load a module from a string at runtime | ✓ `env.LOADER.get(name, async () => ({ mainModule, modules, env, globalOutbound, tails }))` |
| Cache by name | ✓ Three requests fetched the code once. Module state persists between requests to the same hash. |
| Per-request bindings | ✓ `worker.getEntrypoint(undefined, { props: { dataKey } }).fetch(req)`; the backend sees `ctx.props`. `env` is fixed per loaded Worker, so the loader wraps the backend in a small shim module that builds `env.DATA` from `ctx.props.dataKey` on each request. `DATA` calls a `WorkerEntrypoint` in another service over RPC, which calls the app with the key. The backend can read its own `dataKey`; that grants nothing extra, because the key names only its artifact and expires in 30 s. |
| `globalOutbound: null` blocks network | ✓ `fetch` to the internet, to the app by IP and by service name, and `connect()` all throw "This worker is not permitted to access the internet". |
| No environment or file system | ✓ `process` exists but `process.env` is `{}`. `node:fs` is a virtual file system (`/etc/hosts` doesn't exist). No `Bun`, `Deno` or `require`. |
| Isolation between backends | ✓ A global set by one hash isn't visible to another. |
| Console capture for `artifacts logs` | ✓ A tail worker (`tails: [env.LOGS]`) receives `console.log` and `console.error` lines with timestamps, plus uncaught exceptions with `outcome: "exception"`. The `X-Artifacts-Logs` header fallback in 08 isn't needed. |
| Runner secret check | ✓ 401 without it. |

**What doesn't:**

1. **Worker loaders are experimental.** workerd refuses the `workerLoader` binding unless it runs with `--experimental` ("may change or go away in the future"). The runner would pin a workerd version and pass the flag.
2. **No CPU limit.** `limits: { cpuMs: 50 }` is accepted on `get()` and `getEntrypoint()` and ignored: a busy loop ran its full 20 seconds. This build of workerd has nowhere to enforce it.
3. **One busy backend stalls every backend.** While one backend looped, a request to a different artifact's backend got no answer for the whole time. A JavaScript loop can't be interrupted from inside workerd, so the 10-second limit in SPEC §7.9 can't be enforced per backend, and the app's 11-second abort only frees the app, not the runner.
4. **No memory limit.** One backend allocated 4 GB of typed arrays. With a process-wide heap cap (`v8Flags = ["--max-old-space-size=256"]`), typed arrays still weren't capped, and filling the JavaScript heap **crashed the whole workerd process** (exit 1), taking every backend with it.

**Deno, on the same tests** (one Deno `Worker` per backend, `deno: { permissions: "none" }`, which needs `--unstable-worker-options`). The host ran with what a real runner needs: `--allow-net=<app>`, `--allow-env=RUNNER_SECRET` and `--allow-read=.` (`spikes/s4-deno/host2.ts`, `host3.ts`).
- ✓ The worker gets none of the host's permissions (`NotCapable` for each):
  - `fetch` to the app and to the internet; `Deno.connect` and `Deno.listen`
  - `Deno.env.get("RUNNER_SECRET")` and the whole environment
  - reading the host's folder and `/etc/hosts`, and writing a file
  - spawning a process (`new Deno.Command("id").output()`) and `Deno.dlopen`
  - `npm:` and `file:` imports, and starting a nested Worker with `permissions: "inherit"`
- ✗ **Remote imports leak by default.** A literal `import("https://esm.sh/…")` or `import("jsr:…")` in the backend **downloaded and ran**, because Deno 2 allows imports from a default list of hosts whatever the `net` permission says. Computed URLs and other hosts were denied. **With `--no-remote` on the host, all of them are denied.** A Deno runner must run with `--no-remote --no-npm`, and the backend lint rejects remote imports anyway.
- ✓ **A busy backend doesn't stall others,** because each Worker is its own thread. `worker.terminate()` stopped the loop at the 3-second test timeout.
- ✗ **No memory limit either:** typed arrays are uncapped, and heap exhaustion crashes the whole Deno process.

**Decision needed: the runner.** The capability sandbox, which is the security boundary, holds in both. The difference is runaway code: an infinite loop in an agent-written backend is a likely accident.
- **A. Keep workerd, add a watchdog.** A small supervisor in the runner container restarts workerd when a request outlives its limit or memory passes a threshold. One stuck backend still stalls all backends until the restart, a few seconds after the timeout. It relies on an experimental feature.
- **B. Switch to Deno** (the documented fallback). Timeouts are enforced per backend, and nothing stalls others. A supervisor still restarts the process on memory exhaustion. It relies on an unstable flag, and must run with `--no-remote --no-npm`. It loses workerd's Workers-compatible module and `ctx.props` details, but the agent-facing contract (`fetch(request, env)`, `env.DATA`, `caller()`) is unchanged. Logs come from wrapping `console` in the Worker.
- **C. Keep workerd and accept it.** Document that limits are best-effort, and rely on Railway restarting a crashed runner.

Recommendation: **B, Deno, with a supervisor for memory.** It's the only option that enforces the 10-second limit and keeps one artifact from freezing the rest. This is Phase 2 (M10), so it doesn't block M1. Either way, SPEC §7.9's "10 seconds per request and 128 MB of memory" needs rewording: memory is a per-runner cap that restarts the runner, not a limit per backend.

### Option D: QuickJS in the app (tested 2026-10-30)

You asked for the simplest runner, not necessarily workerd or Deno. The simplest shape removes the runner service entirely. Each backend runs in **QuickJS compiled to WebAssembly** (`quickjs-emscripten` 0.31), inside the app, on a Bun worker thread. Script: `spikes/s4-quickjs/`.

| Check | Result |
|---|---|
| Load from a string, cache by hash, module state kept between requests | ✓ |
| `env.DATA` as host functions returning promises | ✓ |
| No network, environment or modules | ✓ No `fetch`, `XMLHttpRequest`, `WebSocket`, `process`, `Bun`, `Deno`, `require` or timers exist in the sandbox. `import("https://…")` fails: "could not load module". Nothing reaches the host except functions the app passes in. |
| Isolation between backends | ✓ Separate QuickJS runtimes; globals don't leak. |
| **CPU limit** | ✓ A `while (true) {}` is interrupted at the deadline (tested at 1,000 ms and 500 ms). |
| **The app stays responsive** | ✓ The app's main thread kept running (91 of ~100 timer ticks) during a busy backend, because QuickJS runs on a worker thread. |
| **Memory limit** | ✓ Both heap objects and typed arrays stop at the per-runtime limit (32 MB in the test) with "out of memory". Only that backend fails; the next request to another backend works. |
| Console capture | ✓ `console.log` and `console.error` reach the app. |
| Speed | A warm request takes about 0.1 ms. QuickJS is an interpreter, much slower than a JIT for heavy computing, but small request handlers don't notice. |
| Memory after a failure | With one shared WebAssembly instance, memory grew to its 2 GB maximum during an out-of-memory failure (QuickJS's own limit doesn't cap the allocator underneath), and never shrank. **Fixed by giving each backend its own instance with a capped `WebAssembly.Memory`** (`spikes/s4-quickjs/capped.ts`, 64 MB maximum): typed-array, string and heap floods all stop at about 67 MB, deep recursion stops with "stack overflow", process RSS stays at 100–150 MB, and the host is unaffected. Creating an instance takes about 15 ms; 100 warm instances used about 356 MB. |

What it costs:
- **Web APIs:** QuickJS has the language but not the Web platform (`Request`, `Response`, `Headers`, `URL`, `TextEncoder`). The kit's `backend` module provides small versions, bundled into each backend by `bun build`. The agent-facing contract is unchanged: `export default { fetch(request, env) }`, `env.DATA`, `caller()`.
- **Clean-up:** the spike leaked handles, so freeing a runtime printed an assertion. Real code disposes handles properly, or replaces the worker thread.

What it removes:
- the `runner` service, its image and its Serverless wake (S6)
- `RUNNER_URL` and `RUNNER_SECRET`, and the runner half of the internal API
- workerd's experimental flag and Deno's unstable flag

The capability boundary is WebAssembly memory safety in Bun's engine, a strong, well-tested boundary. It fits the threat model (only invited people publish).

**Recommendation: D, QuickJS in a child process of the app** (after the Fable audit, 2026-10-30): the same code, but the sandbox runs in a `Bun.spawn` child with an empty environment and only an IPC channel, so even an engine-level escape can't reach the database URL, bucket keys or `SESSION_SECRET`. One capped WebAssembly instance per backend, a small pool, per-request deadlines, size caps on requests, responses and logs, and eviction of instances whose memory grew. It's the simplest of the four, and the only one that enforces both the 10-second and the 128 MB limit per backend. **Decided 2026-10-30** (the user agreed): SPEC §7, §7.5, §7.9, §11, §12 and §15, and 01, 02, 03, 04, 08, 09, 10 and 11 now describe the sandbox, and the runner service is gone.

## S5 · The compiled Bun CLI

**Scripts:** `spikes/s5-cli.ts` (compiled probe), `spikes/s5-linux-inner.sh` (the same in Linux containers), `spikes/s5-server-sharp.ts`, `spikes/.pw/rt/helper.mjs`.

| Question | macOS arm64 | Linux arm64 | Linux amd64 |
|---|---|---|---|
| The compiled binary imports `playwright-core` from an outside folder (absolute `file:` URL) and drives WebKit | ✓ | ✓ | ✓ |
| `Bun.secrets` set, get and delete | ✓ (Keychain) | ✗ headless: `ERR_SECRETS_PLATFORM_ERROR`, "Cannot autolaunch D-Bus without X11 $DISPLAY" | ✗ same |
| sharp **bundled inside** the binary | ✗ "Could not load the sharp module" | ✗ | ✗ |
| sharp loaded from an outside folder | ✗ The binary doesn't resolve bare imports (`detect-libc`) inside outside packages. Playwright works only because it has no dependencies. | ✗ | ✗ |
| **The binary re-run as Bun (`BUN_BE_BUN=1 artifacts <script>`) running a helper that uses Playwright and sharp from the outside folder** | ✓ | ✓ | ✓ |
| sharp on the server image (`oven/bun:1.4.2-slim`, with a crop like 05's) | ✓ (Bun, not compiled) | ✓ | ✓ |
| **First run on a machine with only the CLI** (`debian:bookworm-slim`, no Bun or Node, a non-root user): `BUN_BE_BUN=1 artifacts add playwright-core sharp`, then `… node_modules/playwright-core/cli.js install webkit`, then the helper | | ✓ sharp's Linux packages install. WebKit downloads after its system libraries are installed as root (`… cli.js install-deps webkit`, once). The helper renders and encodes. | |
| Cross-compiling | darwin-arm64, darwin-x64, linux-x64, linux-arm64 and windows-x64 all build (62–86 MB) | | |
| Windows | **Untested** (no Windows machine here). | | |

**Design change ([07](07-cli-and-skill.md#build-and-distribution)):** on first render the CLI installs `playwright-core`, sharp and its own render helper script into `~/.artifacts/playwright/`. It runs rendering, image encoding and hashing by spawning itself with `BUN_BE_BUN=1`, so nobody needs Bun or Node installed (verified in a clean Linux container). Two details:
- Call Playwright's `cli.js` directly. `bun x playwright-core` follows the `#!/usr/bin/env node` line and fails without Node.
- On Linux, WebKit's system libraries need root once. Running `--with-deps` in the earlier containers worked only because they ran as root. `doctor` prints the `sudo` command. Everything else stays in the binary. Credentials use `Bun.secrets` and fall back to the 0600 file when it throws (headless Linux, CI), as 07 already allowed.

**Note:** 09's Dockerfile sketch says `oven/bun:1.2`; the spikes used 1.4.2. M1 pins `.bun-version` to 1.4.2 and updates the sketch.

## S7 · Codex skills folder

Read from the installed CLI, with no model call: `codex debug prompt-input` renders the prompt locally, including its skills list. Test skills went into three folders, with a temporary `HOME` and `CODEX_HOME`.

| Folder | Loaded by Codex 0.166.0 |
|---|---|
| `$CODEX_HOME/skills/<name>/SKILL.md` (default `~/.codex/skills/`) | ✓ |
| `~/.agents/skills/<name>/SKILL.md` | ✓ (always) |
| `~/.codex/skills/` while `CODEX_HOME` points elsewhere | ✗ |

Codex's own skill-creator instructions say the same: "create discoverable skills in `$CODEX_HOME/skills`, or `~/.codex/skills` when `CODEX_HOME` is unset." **Install to `${CODEX_HOME:-~/.codex}/skills/artifacts/`**, and not also to `~/.agents/skills/`, which would list the skill twice. 07 already said this; it's now confirmed.

## S8 · Live frames in WebKit

**Script:** `spikes/s8-live-frames.ts`. The viewer is on `http://localhost:18080` and the content host on `http://127.0.0.1:18081` (different sites), in Playwright WebKit 27.2. A `sandbox="allow-scripts"` iframe loads a page that uses a module script with a relative import, a stylesheet with `@font-face`, an image, a relative `fetch`, a `POST` to `api/votes` with a JSON body (preflighted), and `postMessage` to the parent.

| Check | CSP naming the content origin (03) | CSP with `'self'` |
|---|---|---|
| Module script and its relative import | ✓ | ✓ |
| `@font-face` font, stylesheet, image | ✓ | ✓ |
| Relative `fetch` | ✓ | ✗ "Refused to connect … connect-src" |
| `POST api/votes` (preflight `OPTIONS` answered, then `POST`) | ✓ | ✗ blocked |
| `fetch` to the viewer origin or the internet | blocked ✓ | blocked ✓ |
| `localStorage`, `document.cookie` | `SecurityError` ✓ | `SecurityError` ✓ |

So `'self'` doesn't match the opaque origin for `connect-src`; naming the content origin, as 03 does, is required.

**Headers WebKit sends to the content host** (all `Sec-Fetch-Site: cross-site`):

| Request | `Sec-Fetch-Dest` | `Sec-Fetch-Mode` | `Origin` |
|---|---|---|---|
| The iframe document | `iframe` | `navigate` | none |
| Stylesheet, image, font | `style`, `image`, `font` | `no-cors` | none |
| Module scripts | `script` | `cors` | `null` |
| `fetch`, preflight and `POST` | `empty` | `cors` | `null` |
| **Top-level navigation** | `document` | `navigate` | none (`Sec-Fetch-Site: none`) |

The content host refused the top-level navigation with 403, as 03 specifies.

**The bridge:** messages from the live frame arrive with `event.origin === "null"`. A second sandboxed iframe sending the same message was rejected by the `event.source === liveIframe.contentWindow` check, as 08 says.

03 now records the confirmed `Sec-Fetch-Dest` values.

**Rerun with the CSP's `sandbox allow-scripts`, and media (2026-10-30, `spikes/s8-csp-sandbox.ts`, WebKit 27.2).** All passed: module script and relative import, `@font-face`, image, relative `fetch`, preflighted `POST api/votes`, and `audio`, `video` and `track` (`Sec-Fetch-Dest` `audio`, `video` and `track`, mode `no-cors`, no `Origin`). `self.origin` is `"null"`; `localStorage` and cookies throw `SecurityError`; `top.location` is blocked; `fetch` to the viewer or the internet is refused by `connect-src`. A page on an origin not in `frame-ancestors` can't embed the frame. A document served with `sandbox allow-scripts` opened at the top level is still opaque, with no storage. Real Safari on an iPhone asks for byte ranges on media, so the content host answers `Range` requests (M9); that part needs a real device.

## S1, S3 and S6 on Railway (run 2026-10-30)

A throwaway project `artifacts-spike` in the Mochahub workspace, created through the Railway connector. It has:
- `app`: `oven/bun:1.4.2-slim` running `spikes/railway/app.ts` from a base64 variable
- `runner`: the same image with `ROLE=runner` and Serverless on
- a bucket, and Postgres from the `postgres` template

**S1:**

| Question | Result |
|---|---|
| Several generated domains on one service, by target port | ✓ Three: `app-production-4454` → 8080, `app-production-eb94` → 8081, `app-production-3e6b` → 8083 (all `*.up.railway.app`). The connector's `generate-domain` tool only returns the existing domain, but Railway itself accepts more (added through Railway's agent, i.e. the API). The Railway CLI's `railway domain --port` is the path `artifacts setup` uses. |
| `${{secret(n)}}` on an image service we created | ✓ `SETUP_TOKEN` was 48 characters, `SESSION_SECRET` 64. |
| Bucket variables | `${{<bucket>.ENDPOINT}}`, `BUCKET`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`. The endpoint is `https://t3.storageapi.dev`, region `auto`, and Railway's preferred URL style is virtual-host. |
| Postgres | ✓ `${{Postgres.DATABASE_URL}}` |
| Private hostnames | `<service>.railway.internal` (`app.railway.internal`, `runner.railway.internal`); `${{runner.RAILWAY_PRIVATE_DOMAIN}}` resolves. |
| `RAILWAY_PUBLIC_DOMAIN` | Holds **only the first** generated domain (port 8080), and only after a redeploy following the domain's creation. **There's no variable for the content domain**, so the template can wire `PUBLIC_URL` but not `CONTENT_URL`: `artifacts setup` reads both domains with `railway domain list --json` and sets `CONTENT_URL` with `railway variable set`. Until then the server stays in setup mode. Noted in 09. |
| `railway templates create` and `railway deploy --template` | **Not run.** The connector can't create templates and the Railway CLI is signed out. This waits for M8, when the real image exists. |

**S3, Railway half:** **22/22 in both virtual-host and path-style URLs** against the Railway bucket (Tigris behind `t3.storageapi.dev`). Conditional writes, conditional delete, `If-Match` on a missing key (404), presigned PUT with signed headers, day-stable presigned GETs, and response overrides all work. The test ran inside the `app` container, because the connector returns bucket keys redacted. Whether Safari keeps presigned GETs cached is checked on the iPhone in M4.

**S6:** with Serverless on, the runner went to sleep about 9 minutes after start with no traffic ("Stopping Container"). A request from `app` to `http://runner.railway.internal:8090/` woke it: the first and only attempt answered 200 after 1,019 ms (the process reported 566 ms since start). No 502, so no retry is needed. That's one sample.

**Still running:** the project stays up for the S2 iPhone test, then gets deleted.

## S2 · Passkeys across domains (run 2026-10-30)

On the user's iPhone, against the Railway spike app:
1. A passkey was created on the home domain `app-production-4454.up.railway.app` (rpId = that host).
2. On a second domain, `app-production-3e6b.up.railway.app`, whose home domain lists it in `/.well-known/webauthn`, `navigator.credentials.get({ rpId: <home> })` returned:

```json
{ "result": "SIGNED IN", "page": "app-production-3e6b.up.railway.app", "rpId": "app-production-4454.up.railway.app",
  "clientDataOrigin": "https://app-production-3e6b.up.railway.app", "crossOrigin": false }
```

Related Origin Requests work across two `up.railway.app` domains, which count as separate sites because that suffix is on the Public Suffix List. The server must accept `clientDataJSON.origin` from any viewer origin while checking `rpId` against the home domain, as 04 says. **Not tested:** desktop Chrome, and the "Sign in on the home domain" fallback link (a plain link; low risk). Test them on a real deploy in M6.

## The original runbook

These create billable resources on your Railway account and need your go-ahead. One deploy covers all three. It uses a stand-in app (`spikes/railway/app.ts`, about 150 lines, no dependencies), not the Artifacts image, so nothing is published. Expected cost: cents. Delete the project afterwards (`railway delete`).

**What the stand-in app does:**
- **Ports 8080 and 8083:** two viewer domains (A, the home domain; B, a second domain), each with a passkey test page. Port 8080 serves `/.well-known/webauthn` listing B.
- **Port 8081:** a content-domain stand-in.
- **`/s1` on any port:** the Host it saw, every variable *name* (values aren't printed), the lengths of `SETUP_TOKEN` and the other generated secrets, and the `RAILWAY_*` domain variables.
- **`/wake` on port 8080:** calls the runner at `http://runner.railway.internal:8090/` and times each attempt.
- **With `ROLE=runner`:** listens on 8090 for the wake test.

**Steps (Railway CLI 5.71.0; I run them with you, after `railway login`):**
1. `railway init --name artifacts-spike --json`, run in `spikes/railway/`.
2. `railway add --service app`, then `railway up --service app` (builds `spikes/railway/Dockerfile`).
3. `railway domain --service app --port 8080`, then the same for `--port 8081` and `--port 8083`. **S1: can one service have three generated domains?** If not, B moves to a second service.
4. `railway variable set` on `app`: `SETUP_TOKEN=${{secret(48)}}`, `SESSION_SECRET=${{secret(64)}}`, `VIEWER_A_URL`, `VIEWER_B_URL`. **S1: do `${{secret()}}` functions resolve on a service we created?** (In templates they're template variable functions; step 9 checks those.)
5. `railway bucket create spike --json`, then `railway bucket credentials --bucket spike --json`. **S1: the bucket's variable names**, and how a service references them.
6. `railway add --database postgres`. **S1: `DATABASE_URL` reference syntax.**
7. **S3, Railway half:** `S3_*` from step 5, plus `S3_BUCKET=<the bucket's real name>` and `S3_CREATE_BUCKET=false`; then run `bun spikes/s3-conditional.ts` locally against the bucket's public endpoint. If the endpoint refuses path-style requests, run it again with `S3_FORCE_PATH_STYLE=false`, and record which works (it changes `S3_FORCE_PATH_STYLE`'s default in 09).
8. **S6:** `railway add --service runner`, `railway up --service runner` with `ROLE=runner`, then turn on Serverless for `runner` (dashboard, or the Railway MCP `update-service`). Wait 15 minutes with no traffic, open `<A>/wake`, and record the wake time and any 502s. Repeat 3 times.
9. **S1, templates:** `railway templates create --project artifacts-spike --json` makes an **unpublished** template draft (not public). Check in the template editor that the bucket, both domains and `${{secret()}}` survive. Then `railway init --name artifacts-spike-2` and `railway deploy --template <code>` to test provisioning into an existing project. **Publishing the template to the marketplace is outward-facing, and isn't part of this.**
10. `railway delete` both projects, and the template draft.

**S2 on your iPhone (iOS 18+) and in desktop Chrome:**
1. Open `<A>/`. Press 1 to see `getClientCapabilities()` (look for `relatedOrigins: true`), then 2 to create a passkey.
2. Open `<B>/` and press 3. **Pass:** "SIGNED IN" with `rpId` = A's host and `clientDataOrigin` = B. **Fail:** a `SecurityError`.
3. On B, follow "Sign in on the home domain" and press 3 on A (the fallback).
4. Optionally, press 2 on B (creating a passkey for A from B; browsers differ here).

## Doc changes made with these results

- [03](03-api.md#content-host-live-previews): the confirmed `Sec-Fetch-Dest` values, and that `'self'` fails for `connect-src`.
- [05](05-publish-and-storage.md#presigned-urls): the S3 client must turn off default request checksums.
- [07](07-cli-and-skill.md#build-and-distribution): the render helper via `BUN_BE_BUN=1`, with sharp installed beside Playwright; the `Bun.secrets` fallback on headless Linux; the Codex skills folder confirmed.
- [08](08-micro-apps.md): `If-Match` on a missing key answers 412; the S4 results noted at the runner, pending your decision.
- MinIO replaced by SeaweedFS in SPEC, 05, 07, 09, 10 and 11.
- The runner service replaced by the QuickJS sandbox (SPEC, 01, 02, 03, 04, 07, 08, 09, 10, 11).
- The audit fixes (2026-10-30):
  - `sandbox allow-scripts` in the content host's CSP, and requests without `Sec-Fetch-Dest` refused (03)
  - `artifact.publish` limited to the publisher, admins and members given `publish` (02, 03, 04, 07, SPEC §7.3)
  - `env.DATA` read-only for viewers (04, 08)
  - the device code no longer in the approval link (03, 06)
  - `org.pseudonym_key`, so `SESSION_SECRET` can be rotated (02, 04, 08, 09)
  - an `artifact_usage` table instead of `_usage.json` and its lock fallback (02, 08, SPEC §7.9)
  - a backend request rate limit (04)
