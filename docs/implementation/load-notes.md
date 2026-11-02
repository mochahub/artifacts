# Load notes

From 2026-10-30, on the Docker image on one Apple Silicon Mac, with client, app, Postgres and SeaweedFS on the same machine. These show the app's own footprint and where its limits sit. They aren't Railway numbers, so SPEC §7.5 keeps its estimates until a real deployment is measured.

| Check | Result |
|---|---|
| App idle | 60–105 MiB |
| 50 viewers polling `/api/home` once a second with ETags, 20 s | 1,000 requests, p50 35 ms, p99 124–164 ms, no 5xx, 120 MiB |
| 20 publishes of a one-frame artifact in a row, CLI rendering included | 65 s, no failures, 94 MiB afterwards |
| 100 requests a second at one backend doing `env.DATA.get`, 15 s, with the rate limit raised | 651 answered, p50 25 ms, p99 79 ms, 819 refused with 503 `busy`, 160 MiB |

One backend runs one request at a time (08), so it handled about 43 requests a second here and refused the rest. That's the design working: it queues 4, then says `busy`. The normal limit of 120 requests a minute per caller means it takes about 20 people at full rate to reach this.

## Team grants (M17, 2026-11-01)

Lists stay at one query per concern: `visibleTo` adds one query, for the caller's own team grants, joined on `team_members(person_id)`. `toResource` loads everyone's, and adds one join per artifact. `/api/activity` looks at up to 200 rows, so it and the daily digest now load their artifacts in one batch, which is fewer queries than before M17. An event stream runs two lookups and the artifact's three on each 25-second heartbeat. Not measured under load.

## Search (M12, 2026-10-31)

`visible()` reads one row per artifact on every search, list and read, because `can()` decides in code. `GET /api/library/search` with `limit=20`, median of five, on the test stack on one Apple Silicon Mac, with 20 article blocks per artifact:

| Artifacts | Blocks | A word in 2% of artifacts | A word in every block | No matches | `GET /api/library/projects` |
|---|---|---|---|---|---|
| 1,000 | 20,000 | 101 ms | 319 ms | 45 ms | 17 ms |
| 10,000 | 200,000 | 288 ms | 2,501 ms | 242 ms | 161 ms |

SPEC §7.5's largest deployment has 1,000 artifacts, so this is fine there. A word in every block is the worst case, because each match gets ranked. The 60 searches a minute per caller also bound it. Past 10,000 artifacts, the place to start is pushing the visibility rule into SQL for the common case, with `can()` still deciding.
