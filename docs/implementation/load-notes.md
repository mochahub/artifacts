# Load notes

From 2026-10-30, on the Docker image on one Apple Silicon Mac, with client, app, Postgres and SeaweedFS on the same machine. These show the app's own footprint and where its limits sit. They aren't Railway numbers, so SPEC §7.5 keeps its estimates until a real deployment is measured.

| Check | Result |
|---|---|
| App idle | 60–105 MiB |
| 50 viewers polling `/api/home` once a second with ETags, 20 s | 1,000 requests, p50 35 ms, p99 124–164 ms, no 5xx, 120 MiB |
| 20 publishes of a one-frame artifact in a row, CLI rendering included | 65 s, no failures, 94 MiB afterwards |
| 100 requests a second at one backend doing `env.DATA.get`, 15 s, with the rate limit raised | 651 answered, p50 25 ms, p99 79 ms, 819 refused with 503 `busy`, 160 MiB |

One backend runs one request at a time (08), so it handled about 43 requests a second here and refused the rest. That's the design working: it queues 4, then says `busy`. The normal limit of 120 requests a minute per caller means it takes about 20 people at full rate to reach this.
