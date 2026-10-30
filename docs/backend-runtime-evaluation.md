# Where artifact backends run: evaluation

> **Superseded 2026-10-30.** Spike S4 found that neither workerd nor Deno enforces per-backend memory limits, and workerd doesn't enforce CPU limits either. Backends now run in QuickJS (WebAssembly) in child processes of the app. See [implementation/spikes.md](implementation/spikes.md#s4--workerd-worker-loader) and [implementation/08-micro-apps.md](implementation/08-micro-apps.md#backends-the-sandbox-appsserversrcsandbox). This evaluation is kept for its reasoning.

Written 2026-10-29.

> **Decision (2026-10-29):** workerd, as recommended below. Backends reach only their own data folder for now: no network, no secrets.

The question: an artifact's backend code is stored in the bucket with its version (SPEC §7.9). What loads it at request time and runs it in a sandbox, inside the Railway project and with no other platform involved?

Every option except Railway Functions is a **runner**: one extra service in the Railway project, with no public domain and no secrets. It loads a backend's code from the bucket by content hash, keeps it warm while in use, and runs it isolated from other backends. The container is the outer layer of defence in every case.

## The options

1. **workerd.** The open-source runtime behind Cloudflare Workers (Apache 2.0), run as a plain container on Railway. No Cloudflare account or service.
2. **Deno.** A runner that starts each backend in a Deno Web Worker or subprocess with a reduced permission set.
3. **isolated-vm.** A Node.js runner that gives each backend its own V8 isolate.
4. **QuickJS in WebAssembly** (`quickjs-emscripten`). A JavaScript interpreter compiled to WebAssembly, run inside a Bun runner.
5. **Railway Functions,** or a Railway service per backend. Railway-native, with no runner.

## Comparison

| | workerd | Deno | isolated-vm | QuickJS (WASM) | Railway Functions |
|---|---|---|---|---|---|
| Load code at runtime | **Yes, built in:** a "worker loader" binding loads Workers from code at runtime, caches them by name and unloads idle ones (in workerd's config schema, checked 2026-10-29) | Yes: start a Worker or subprocess from a file | Yes: compile a string into an isolate | Yes: evaluate a string or load modules | **No:** each function is a deployed service; deploys take "seconds" |
| Several versions live at once | Yes: cache name = code hash | Yes | Yes | Yes | No: one service runs one deployment, so a service per version |
| Code agents write | Web-standard `fetch(request, env)`, the most common serverless shape | Web-standard; `export default { fetch }` works with `deno serve` | Custom glue; no Web APIs inside unless bridged | Custom glue; `fetch`, `Request` and `crypto` must be shimmed | Bun TypeScript, 1 file, max 96 KB |
| npm packages | Bundled at publish | Bundled, or `npm:` imports | Pure JS, bundled | Pure JS, bundled; slow | Installed automatically |
| Isolation, by its own docs | V8 isolates with capability bindings; outbound network can be cut to nothing. The README says it is **"not a hardened sandbox"** and to add another layer, such as a VM | Permission flags, and Workers with reduced permissions. The docs say to use **"more than one layer of defense"** for untrusted code | V8 isolates. **In maintenance mode.** Memory limit is soft ("2–3 times this limit") | WebAssembly memory sandbox, no host access unless granted. **"Has not been audited"**, pre-1.0 | A container per function |
| Memory and time limits | **Unverified** in self-hosted workerd; the runner enforces wall-clock timeouts either way | Terminate the Worker on timeout; memory per subprocess | Built in | Built in | Container limits |
| Cold start | Isolates, so milliseconds (**unverified** here) | Worker tens of ms, subprocess more (**unverified**) | Milliseconds | Milliseconds; slow execution | Seconds after sleeping, and a deploy per change |
| `artifacts dev` locally | `workerd` npm package | Deno binary | Native build | Pure npm | No |
| Docker Compose too | Yes | Yes | Yes | Yes | No |

## Recommendation

**workerd as the runner, with Deno as the fallback.** Agents write backends against the Web-standard `fetch(request, env)` module, which both accept, so backend code doesn't change if we switch.

- **workerd fits the job most directly.** Load code at runtime, cache by name, unload when idle, and give each backend only the bindings it's handed (`DATA`, `SECRETS`) with outbound network off by default. That's the design in §7.9. Agents also know the Workers API well.
- **Its caveat is explicit:** it isn't a hardened sandbox on its own. Here the second layer is the container: the runner has no secrets, no database credentials, no bucket keys and no public domain, and it only reaches the app over the private network with per-request keys. That fits a self-hosted deployment where everyone who can publish was invited. A hosted multi-tenant service would need a VM-level sandbox per tenant.
- **Deno is the closest alternative.** It has the same handler shape, a mature permission model and no Cloudflare lineage. It needs more of our own code for loading, caching and limits.
- **Not recommended:**
  - isolated-vm: maintenance mode, and a custom API.
  - QuickJS: unaudited, slow, and no Web APIs.
  - Railway Functions: no runtime loading, one live version per service, 96 KB, a service per backend to clean up, and no Docker Compose.

## To verify with a prototype before building backends

These are spikes S4 and S6 in [implementation/11-milestones.md](implementation/11-milestones.md).

1. workerd's worker loader in a self-hosted container: load a module from a string, call it, confirm idle unloading, and confirm it needs no experimental flag.
2. Memory and CPU limits in self-hosted workerd: what's enforced, and what the runner must do itself.
3. Cold start and warm latency on Railway, over the private network from the app.
4. Outbound blocking with a per-backend allowlist.
5. The same five-handler test suite on a Deno runner, to keep the fallback real.
6. Idle cost of the extra service on Railway, with and without Serverless sleeping.

## Sources

- [workerd README](https://github.com/cloudflare/workerd) and [config schema](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) (worker loader binding)
- [Cloudflare docs: Worker Loader binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader)
- [Deno security and permissions](https://docs.deno.com/runtime/fundamentals/security/)
- [isolated-vm](https://github.com/laverdet/isolated-vm)
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)
- [Railway Functions](https://docs.railway.com/functions)
