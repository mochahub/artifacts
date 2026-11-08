# Private executor boundary (opt-in)

Public hosted server → HTTPS private executor ingress → loopback Bun executor → fixed local immutable Docker image. Only the dedicated single-purpose Linux host has Docker access. Never give the public app a Docker socket, launcher, Docker credentials or image selector. The extraction container receives only bytes on stdin and the validated MIME argument; no network, host mounts, secrets or caller-selected command/image/path. launcher.ts preserves the existing container constraints.

Run from a checkout containing the server extractor modules. Build/review/scan the parser image first, install it locally, and record its sha256 image ID. Provision one random 32-byte binary HMAC key per app/executor pair through the lead's secret mechanism; synthetic repeated-byte keys in tests are NOT deployment keys. No keys were provisioned by this work. Protect key files (0400). The HMAC key gives both sides authority to impersonate the other: keep this service single tenant, rotate both sides together, and restart executor on rotation.

## Configuration and root runtime integration

Executor entry point: `bun deploy/extractor/executor/server.ts`. Executor-only environment variables:

| Variable          | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| EXECUTOR_IMAGE    | Required immutable locally installed `sha256:<64 hex>` image ID; never pulled |
| EXECUTOR_KEY_FILE | Required path to raw 32-byte shared key on executor host                      |
| EXECUTOR_BIND     | HTTP upstream bind; default 127.0.0.1; keep loopback behind TLS ingress       |
| EXECUTOR_PORT     | HTTP upstream port; default 8090                                              |

The app client reads **no environment variables**. Root runtime owner must explicitly construct `remoteExtractor({ endpoint: fixedPrivateHttpsOrigin, key: binaryKey })` and inject it at the existing `SandboxedExtractor` dependency in trusted ingestion construction. No root env/jobs/content tools were edited. Proposed app configuration names, NOT implemented or accepted by env.ts here: `LIBRARIAN_EXTRACTOR_ENDPOINT` and `LIBRARIAN_EXTRACTOR_KEY_FILE`. Root owner must validate/read those and preserve OFF/kill-switch/authorization semantics. Missing config must leave extraction unavailable; never fall back. Endpoint is one deployment-owned HTTPS origin (no credentials/path/query/fragment); never read from source, user or model data. Default TLS CA/hostname checks stay on; install private CA trust at the platform, never disable verification. `testOnlyLoopbackHttp` permits only 127.0.0.1 fixture HTTP and must never be passed by runtime construction. Optional construction `signal` aborts calls (use a per-job adapter for per-job cancellation); existing SandboxedExtractor has no signal field. Deadline failures also send independently bounded signed cancellation.

## Wire contract v1 and limits

GET `/session/<random UUID>` returns an authenticated random startup epoch in headers (204). Its HMAC binds `session-v1`, exact path, epoch. POST `/extract/<job UUID>` carries raw bytes, exact allowlisted MIME, millisecond timestamp, UUID nonce, SHA-256 body hash, startup epoch and HMAC-SHA256. Signed fields, newline separated: `request-v1`, `POST`, exact path, timestamp, nonce, MIME, body hash, epoch. Fields with attacker-controlled delimiters cannot pass the strict route/time/nonce/MIME constraints before launch; exact body hash is checked before parsing. Timestamp window 30 seconds; nonce replay cache 4096 entries/61 seconds, reject on exhaustion; epoch rejects pre-restart captures. Require synchronized clocks. No redirects/retries or automatic discovery. All POST results/errors are HMAC authenticated over `response-v1`, path, request nonce, status, SHA-256 response body. Client discards unauthenticated errors/results and emits only generic errors. Neither side logs source bytes, credentials, command stderr or raw failures.

Two admitted uploads/jobs total, no queue; 60 extraction admissions per minute per key/service, 16 HTTP connections; 10 MiB input, required Content-Length, five-second upload bound; 1 MiB strict UTF-8 output; 15-second sandbox wall deadline; 20-second executor request deadline; 22-second client request deadline and six-second independent cancellation request. Cancellation is signed POST `/cancel/<job UUID>` with an empty body; it aborts only that admitted job. Cancellation acknowledgment means signal delivered, not teardown complete. A single shared identity authorizes all jobs on this dedicated executor. Invalid/overflow/unsupported input never launches a parser. Authenticated clients can exhaust their own quotas; firewall ingress as below.

Disconnect, deadline, cancel and graceful stop force-remove the container, kill/reap Docker CLI and repeat removal after CLI exit to close the create race. Failed teardown verification latches admission closed until restart; daemon failure can prevent actual removal. No claim of teardown while Docker is unavailable. Startup `recover()` force-removes all containers carrying exactly `artifacts.private-executor=v1` before listening, failing closed if Docker fails. A serialized five-second orphan reconciler in the production entry point preserves currently registered launcher names and removes late creates from a killed previous process; reconciliation failure closes admission and aborts active work. Only one executor process may own that namespace: use the supplied flock service example. Stop/start recovery, systemd restart and operator reconciliation are mandatory. Do not run multiple replicas with the same daemon/namespace. Test construction uses private random namespaces; no shared application stack reset is involved.

## Operational gates (still open)

Example service and ingress files are templates, not a deployment. Review paths, Bun version, user/group, TLS certificates and immutable image. Deploy ingress on the dedicated host, restrict it to the hosted app private network identity/IP using firewall/VPN rules, deny all public ingress and constrain host egress independently. Socket access is root-equivalent on this single-purpose host; do not colocate unrelated workloads. Keep raw upstream loopback-only; TLS ingress must propagate disconnect and enforce request limits without logging bodies/auth headers. Public platform private routing and CA trust must be proven before enablement.

Still required: deployed Linux host acceptance (including SIGKILL/reboot/daemon outage, durable service lock and orphan reconciliation), firewall/egress acceptance, key provisioning/rotation, parser/dependency vulnerability review, adversarial corpus/fuzzing and full integrated security review. Local Docker Desktop evidence does not satisfy those gates. OFF absent an explicitly configured executor; no hosted environment or feature flag changed.

## Private tests

Build a uniquely tagged image from `deploy/extractor/Dockerfile`, inspect its immutable ID, then run:

```
TEST_LIBRARIAN_EXTRACTOR_IMAGE=sha256:... bun test apps/server/src/librarian/ingestion/remote-extractor.test.ts deploy/extractor/executor/qualification.test.ts
```

Only synthetic keys/data. Without the image, container tests skip and are not evidence. Tests clean only their random-labeled containers and image tags. Remove the caller-created parser image tag afterward. See ../QUALIFICATION.md for actual observations and limitations.
