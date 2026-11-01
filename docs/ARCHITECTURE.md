# Architecture

This is the document to read first. It shows how the pieces fit, with diagrams that GitHub renders. It doesn't repeat the contracts: for names and shapes, follow the links to [docs/implementation/](implementation/README.md), and for behaviour, to [SPEC.md](SPEC.md).

An agent publishes a bundle of pages. People review it and pin comments. The agent reads the comments, fixes the work, publishes again and replies. One server process, one Postgres database and one bucket make that work.

| Piece | What it is |
|---|---|
| CLI (`packages/cli`) | Lints, renders in WebKit, hashes, uploads and commits. Also the way to set up and run a server. |
| Server (`apps/server`) | One Bun and Hono process on three ports. It holds no state in memory that matters. |
| Viewer (`apps/viewer`) | A Preact app the server serves. Phone first, desktop too. |
| Postgres | People, sign-in, projects, artifacts, versions, review, activity. |
| Bucket | Every file, by SHA-256, plus each artifact's data folder. Private. |

## System context

```mermaid
flowchart LR
  subgraph machine["Agent's machine"]
    agent["Coding agent"]
    cli["artifacts CLI"]
    webkit["WebKit via Playwright"]
    agent --> cli
    cli --> webkit
  end

  phone["Person on a phone"]
  desktop["Person on a desktop"]

  subgraph edge["Reverse proxy or Railway, HTTPS"]
    viewerHost["Viewer domain"]
    contentHost["Content domain, Live previews"]
    bucketHost["Bucket address"]
  end

  subgraph server["App container"]
    p8080["Port 8080: viewer and API"]
    p8081["Port 8081: Live previews content"]
    p8082["Port 8082: internal ops"]
  end

  pg[("Postgres")]
  bucket[("S3-compatible bucket")]
  push["Browser push services"]
  gh["GitHub Releases"]
  ops["Operator, private network only"]

  cli -->|"API calls with a CLI token"| viewerHost
  cli -->|"presigned PUT"| bucketHost
  phone --> viewerHost
  desktop --> viewerHost
  phone -->|"sandboxed iframe"| contentHost
  desktop -->|"sandboxed iframe"| contentHost
  phone -->|"presigned GET"| bucketHost
  desktop -->|"presigned GET"| bucketHost

  viewerHost --> p8080
  contentHost --> p8081
  bucketHost --> bucket
  ops --> p8082

  p8080 --> pg
  p8081 --> pg
  p8082 --> pg
  p8080 --> bucket
  p8081 --> bucket
  p8080 -->|"Web Push"| push
  p8080 -->|"new version notice"| gh
```

- **Two sites.** The viewer domain and the content domain must be different registrable domains, so artifact code can't read anyone's sign-in. Railway's generated domains already are. See [SECURITY.md](../SECURITY.md).
- **Port 8082 has no domain.** Nothing public reaches it.
- **The bucket address** is the bucket's own endpoint on Railway. With Docker it is `S3_PUBLIC_ENDPOINT`, because presigned URLs go straight to the bucket.
- **Ports and hosts** are in [03](implementation/03-api.md#servers-and-ports). Variables are in [09](implementation/09-deploy.md#environment-variables).

## The server

```mermaid
flowchart TB
  subgraph p8080["Port 8080: viewer origin"]
    hostGuard["Host check and security headers"]
    guards["API guards: CLI version, setup mode, CSRF, caller"]
    spa["Viewer files and link previews"]
    api["API: home, lists, lifecycle, sharing, people, org"]
    auth["Auth: sign-in, sessions, passkeys, device flow"]
    can["can(): the one permission function"]
    publish["Publish: prepare and commit"]
    review["Review: threads, comments, decisions, re-anchoring, crops"]
    dataApi["Data store: values and files"]
    sse["Events: GET /api/events"]
    pushApi["Push: subscribe and notify"]
    hostGuard --> guards
    guards --> api
    guards --> auth
    guards --> publish
    guards --> review
    guards --> dataApi
    guards --> sse
    guards --> pushApi
    hostGuard --> spa
    api --> can
    publish --> can
    review --> can
    dataApi --> can
  end

  subgraph p8081["Port 8081: content origin"]
    contentGuard["Fetch metadata and path token checks, re-checked every 5 seconds"]
    files["Bundle files, with an in-memory blob cache"]
    proxy["Backend proxy: /t/token/vN/api/*"]
    contentGuard --> files
    contentGuard --> proxy
  end

  subgraph sandbox["Sandbox: no network, no secrets"]
    pool["SandboxPool in the app"]
    child1["Child process 1: QuickJS instances"]
    child2["Child process 2: QuickJS instances"]
    pool <-->|"IPC"| child1
    pool <-->|"IPC"| child2
  end

  subgraph p8082["Port 8082: internal ops, private network"]
    internal["POST /internal/jobs/name"]
  end

  jobs["Jobs, daily: purge, gc, expire, usage, digest"]
  events["Events: Postgres NOTIFY and LISTEN"]
  db[("Postgres")]
  bucket[("Bucket")]
  pushSvc["Browser push services"]

  proxy --> can
  proxy --> pool
  pool -->|"env.DATA calls, scoped by the app"| dataApi
  internal --> jobs
  jobs --> db
  jobs --> bucket
  jobs --> pushApi

  api --> db
  auth --> db
  publish --> db
  publish --> bucket
  review --> db
  review --> bucket
  dataApi --> bucket
  dataApi --> db
  files --> bucket
  publish --> events
  review --> events
  dataApi --> events
  events <--> db
  events --> sse
  pushApi --> pushSvc
  publish --> pushApi
  review --> pushApi
```

- **One guard chain.** Every `/api` request is checked for the CLI's minimum version, setup mode and CSRF, and then resolved to one caller (person, CLI token, organization token, guest or content token). Routes call `can()` before they touch data. Details: [04](implementation/04-auth-and-permissions.md).
- **Realtime is a nudge.** An event says that something changed and holds no content. Each replica listens on one Postgres channel and fans the event out to its open streams. Browsers refetch through their own access.
- **The sandbox is the app's child.** A backend never holds a secret. It asks the app for `env.DATA`, and the app applies the scope it recorded for that request. See [08](implementation/08-micro-apps.md#backends-the-sandbox-appsserversrcsandbox).
- **Jobs run daily** on one replica at a time, behind an advisory lock. `POST /internal/jobs/:name` runs one by hand. See [05](implementation/05-publish-and-storage.md#clean-up).

## Publish

```mermaid
sequenceDiagram
  autonumber
  actor Agent
  participant CLI as artifacts CLI
  participant WK as WebKit render
  participant API as Server, port 8080
  participant DB as Postgres
  participant S3 as Bucket

  Agent->>CLI: artifacts publish -m "..."
  CLI->>WK: lint and render every frame at 1x, 2x and 3x
  WK-->>CLI: renders, frame boxes and content hashes
  CLI->>CLI: SHA-256 of every bundle file and render
  CLI->>API: POST /api/publish/prepare with path, sha256, size and type
  API->>DB: which hashes have a blobs row
  API-->>CLI: uploadId (signed ticket) and a presigned PUT for each missing hash
  par up to 6 at a time
    CLI->>S3: PUT blobs/sha256 with If-None-Match *
    S3-->>CLI: 200, or 412 if the object already exists
  end
  CLI->>API: POST /api/publish/commit with files, pages, frames, blocks
  API->>S3: GET each hash that has no blobs row
  API->>API: hash it, compare with the declared hash and size
  API->>DB: insert blobs rows
  Note over API,S3: A mismatch deletes the object and answers 400
  API->>API: re-sanitize article HTML, store it as a new blob
  API->>DB: one transaction under an advisory lock
  Note over API,DB: version, pages, frames, blocks, re-anchor threads, activity
  API-->>CLI: version, changes, threadsOnChanged, orphaned
  CLI-->>Agent: URL, what changed, threads on changed frames
```

- **Republishing is cheap.** Only hashes without a `blobs` row are uploaded.
- **The bucket isn't trusted.** Anyone holding a presigned PUT chose what went there, so a hash counts as stored only once the server has hashed the object itself.
- **Rendering stays in the CLI.** The server never runs a browser.

Contract: [05](implementation/05-publish-and-storage.md) and [03](implementation/03-api.md#publishing-cli).

## The review loop

```mermaid
sequenceDiagram
  autonumber
  actor Person
  participant View as Viewer in a browser
  participant API as Server
  participant DB as Postgres
  participant S3 as Bucket
  participant Other as Other open viewers
  participant PS as Push service
  actor Agent
  participant CLI as artifacts CLI

  Person->>View: tap a spot on a frame and write a comment
  View->>API: POST /api/artifacts/id/threads
  API->>S3: cut a crop from the 2x render, write crops/thread-id.webp
  API->>DB: insert thread and comment
  API-)Other: NOTIFY, then an SSE thread event
  Person->>API: POST /api/artifacts/id/decisions changes_requested
  API->>DB: insert decision

  Agent->>CLI: artifacts status --json
  CLI->>API: GET /api/artifacts/id/status
  API-->>CLI: decision, note, open and fixed threads
  Agent->>CLI: artifacts comments --open --json
  CLI->>API: GET /api/artifacts/id/threads
  API-->>CLI: anchors, text, authors and signed crop URLs
  Agent->>Agent: fix the source
  Agent->>CLI: artifacts publish
  CLI->>API: prepare, upload and commit (see Publish)
  API->>DB: re-anchor open threads: ok, updated or orphaned
  API-)Other: SSE version event
  API-)PS: Web Push, only when an agent published
  API-->>CLI: threadsOnChanged

  Agent->>CLI: artifacts reply 3 "Moved it" --fixed
  CLI->>API: POST /api/threads/id/comments with marksFixed
  API->>DB: status fixed, fixed_version set
  API-)Other: SSE comment event
  API-)PS: Web Push to the thread's other participants
  PS-->>Person: notification, tap opens the comment
  Person->>API: POST /api/threads/id/resolve
  Note over Person,API: Only a person can resolve. A token can't.
```

- **Nothing is pushed to the agent.** Agents run on people's machines. The skill makes every session start with `artifacts status`, which returns the decision and the open comments.
- **SSE reaches browsers only.** A stream closes after 5 minutes and the browser reconnects, which checks access again. Polling with ETags is the fallback.
- **Re-anchoring** compares each frame's content hash, and finds an article quote again even if its block moved. Rules: [05](implementation/05-publish-and-storage.md#re-anchoring).

## A micro app request

A live frame runs in an iframe with an opaque origin: no cookies, no storage, and no way to call the API itself. It has two ways out. The built-in store goes through the viewer. A backend is called through the content host.

```mermaid
sequenceDiagram
  autonumber
  participant Frame as Live frame, opaque origin
  participant View as Viewer page
  participant API as Server, port 8080
  participant S3 as Bucket

  Note over Frame,S3: Built-in store, through the bridge
  Frame->>View: postMessage op put, scope shared, key, value
  View->>View: accept only from the iframe it created
  View->>API: PUT /api/artifacts/id/data/shared/key with the session cookie
  API->>API: can(): data.write, size and rate limits, usage row lock
  API->>S3: PutObject data/id/shared/key with If-Match or If-None-Match
  S3-->>API: etag, or 412
  API-->>View: etag, or an error
  View-->>Frame: postMessage result
```

```mermaid
sequenceDiagram
  autonumber
  participant Frame as Live frame, opaque origin
  participant Content as Server, port 8081
  participant Pool as SandboxPool
  participant Child as Sandbox child, QuickJS
  participant S3 as Bucket

  Frame->>Content: fetch("api/votes") to /t/token/v5/api/votes
  Content->>Content: verify token, re-check access, rate limit, body size
  Content->>Content: build X-Caller (pseudonym, name, kind, canComment), record read-only scope
  Content->>S3: GET the backend module, stored under its SHA-256
  Content->>Pool: run(hash, request, caller)
  Pool->>Child: request over IPC, one at a time per backend
  Child->>Child: warm instance or load the module, call fetch(request, env)
  Child->>Pool: env.DATA.get("votes") over IPC
  Pool->>Content: onData for this request id
  Content->>S3: GetObject data/id/shared/votes
  S3-->>Content: value
  Content-->>Pool: value
  Pool-->>Child: value
  Child-->>Pool: Response, plus up to 100 log lines
  Pool-->>Content: status, headers, body
  Content-->>Frame: response, no-store, Access-Control-Allow-Origin *
```

- **The app owns the scope.** An `env.DATA` call carries only the request id. The app looks up the artifact and the read-only flag it recorded, and refuses calls for requests that aren't in flight. A backend can't widen what its caller may do.
- **Limits** (time, memory, queue, sizes) are in [08](implementation/08-micro-apps.md#backends-the-sandbox-appsserversrcsandbox).

## Data model

Every table also has `org_id`, except `org` itself. Columns are trimmed to the ones that explain the shape. The full list is in [02](implementation/02-data-model.md).

```mermaid
erDiagram
  org ||--o{ people : has
  people ||--o{ sessions : signs_in_with
  people ||--o{ passkeys : registers
  people ||--o{ tokens : holds
  sessions ||--o{ push_subscriptions : owns
  org ||--o{ projects : has
  projects ||--o{ artifacts : contains
  people ||--o{ artifacts : publishes
  artifacts ||--o{ versions : has
  versions ||--o{ pages : has
  versions ||--o{ frames : has
  versions ||--o{ blocks : has
  artifacts ||--o{ threads : has
  threads ||--o{ comments : has
  artifacts ||--o{ decisions : has
  people ||--o{ decisions : makes
  artifacts ||--o{ artifact_access : grants
  people ||--o{ artifact_access : receives
  artifacts ||--o{ share_links : has
  share_links ||--o{ guest_links : admits
  guests ||--o{ guest_links : uses
  artifacts ||--o{ invites : for
  org ||--o{ blobs : stores

  org {
    uuid id PK
    text name
    text home_domain "passkey RP ID, never changes"
    jsonb settings
  }
  people {
    uuid id PK
    text email
    text role "owner admin member reviewer outside"
    timestamptz removed_at
  }
  sessions {
    uuid id PK
    uuid person_id FK
    text token_hash "SHA-256 of the cookie secret"
    timestamptz auth_at
    timestamptz expires_at
  }
  passkeys {
    uuid id PK
    uuid person_id FK
    text rp_id
  }
  tokens {
    uuid id PK
    text kind "cli or org"
    uuid person_id FK
    text token_hash
    text scopes
  }
  push_subscriptions {
    uuid id PK
    uuid person_id FK
    uuid session_id FK
    text endpoint
  }
  projects {
    uuid id PK
    text slug
    text repo
  }
  artifacts {
    uuid id PK
    uuid project_id FK
    uuid publisher_id FK
    text slug
    text visibility "me or org"
    int latest_version
    bool has_backend
    timestamptz archived_at
    timestamptz deleted_at
    timestamptz purge_after
  }
  artifact_access {
    uuid artifact_id FK
    uuid person_id FK
    text permission "view comment publish"
  }
  share_links {
    uuid id PK
    uuid artifact_id FK
    text token_hash
    timestamptz revoked_at
  }
  guests {
    uuid id PK
    text token_hash
  }
  guest_links {
    uuid guest_id FK
    uuid share_link_id FK
    text name
    timestamptz expires_at
  }
  invites {
    uuid id PK
    uuid artifact_id FK
    text kind "org or artifact"
    text token_hash
  }
  versions {
    uuid id PK
    uuid artifact_id FK
    int n
    jsonb files "path to hash, size and type"
    text backend_hash
  }
  pages {
    uuid id PK
    uuid version_id FK
    text page_key
    text kind "canvas article prototype gallery deck"
  }
  frames {
    uuid id PK
    uuid version_id FK
    text frame_key
    text content_hash "of the 1x pixels"
    jsonb renders
  }
  blocks {
    uuid id PK
    uuid version_id FK
    text block_key
    text content_hash
  }
  blobs {
    uuid org_id PK
    text hash PK
    bigint size
  }
  threads {
    uuid id PK
    uuid artifact_id FK
    int n "per artifact"
    jsonb anchor
    text anchor_state "ok updated orphaned moved_version"
    text status "open fixed resolved"
    int created_version
    int fixed_version
  }
  comments {
    uuid id PK
    uuid thread_id FK
    text body
    int version
    bool marks_fixed
    text agent
  }
  decisions {
    uuid id PK
    uuid artifact_id FK
    uuid person_id FK
    int version
    text kind "approved or changes_requested"
  }
```

Left out of the diagram, and all small:

- Sign-in: `passwords`, `webauthn_challenges`, `reset_links`, `device_codes`
- Reading state: `views`, `guest_views`
- Records: `activity`, `tombstones` (the one line a purge leaves)
- Micro apps: `artifact_usage` (data store counters), `backend_logs`

Threads and comments have either a person or a guest as their author, never both. Bucket prefixes (`blobs/`, `crops/`, `data/`) are in [02](implementation/02-data-model.md#bucket-layout).

## Trust boundaries

```mermaid
flowchart LR
  subgraph viewerOrigin["Viewer origin: holds the sign-in"]
    spa["Viewer app"]
    api["API on port 8080"]
  end

  subgraph contentOrigin["Content origin: another site, no cookies"]
    host["Content host on port 8081"]
    subgraph iframe["Iframe: sandbox allow-scripts, opaque origin"]
      code["Artifact HTML, CSS and JavaScript"]
    end
  end

  subgraph sbx["Sandbox: child processes, no network, no secrets"]
    qjs["QuickJS and WebAssembly: artifact backends"]
  end

  subgraph store["Bucket: private"]
    objects["blobs, crops, data"]
  end

  spa -->|"session cookie"| api
  spa -->|"embeds, minted path token"| iframe
  host -->|"serves"| iframe
  code -->|"postMessage only"| spa
  code -->|"fetch with the path token"| host
  host -->|"request in flight"| qjs
  qjs -->|"env.DATA over IPC, checked by the app"| host
  api -->|"S3 API"| objects
  host -->|"S3 API"| objects
  spa -->|"presigned URL, 302 from the API"| objects
```

| Boundary | What holds it |
|---|---|
| Viewer origin and content origin | Different registrable domains. Cookies are host-only. The viewer's CSP allows `frame-src` for the content origin and nothing else. |
| Content origin and the page | CSP `sandbox allow-scripts` on every response, so the origin is opaque even at the top level. `Sec-Fetch-Dest` must be `iframe` or a sub-resource type, never `document`. |
| Frame and viewer | The `postMessage` bridge. The viewer takes messages only from the iframe it made, and takes the artifact and version from its own record. |
| App and sandbox | An IPC channel. The child has no secrets, and the app checks every call against the request in flight. |
| App and bucket | The bucket is private. Browsers reach it by presigned GET (a day long, stable within a UTC day) and the CLI by presigned PUT (15 minutes). |

Details and assumptions are in [SECURITY.md](../SECURITY.md), [04](implementation/04-auth-and-permissions.md) and [03](implementation/03-api.md#content-host-live-previews).

## Lifecycle

Archiving and deleting are separate flags. An archived artifact can be deleted, and restoring it from Recently deleted returns it to archived. A version can be removed and purged the same way, except the latest or only one.

```mermaid
stateDiagram-v2
  [*] --> Live : first publish
  Live --> Archived : archive
  Archived --> Live : unarchive
  Live --> Deleted : delete
  Archived --> Deleted : delete
  Deleted --> Live : undelete
  Deleted --> Archived : undelete, if it was archived
  Deleted --> Purged : after 30 days, or Delete now
  Purged --> [*]
```

| State | What it means | Who can do it |
|---|---|---|
| Live | Normal. Reviewable, publishable. | |
| Archived | Hidden from lists, links keep working, read-only (no comments, versions or approvals). Data writes are refused. | Publisher or admin. Agents too. |
| Deleted | In Recently deleted for 30 days. Links and share links stop at once. The slug stays taken. | Publisher or admin. Agents too. |
| Purged | Rows, crops and the data folder are erased. One tombstone and one activity line remain. Blobs go in the next garbage collection if nothing else uses them. | A person with a recent sign-in, or the daily job after 30 days. Never a token. |

Rules: [SPEC.md §5.5](SPEC.md#55-archive-and-delete).

## Where to go next

| To learn | Read |
|---|---|
| What it does and why | [SPEC.md](SPEC.md) |
| Table and column names | [02 Data model](implementation/02-data-model.md) |
| Routes, ports, error codes | [03 HTTP API](implementation/03-api.md) |
| Who may do what | [04 Sign-in and permissions](implementation/04-auth-and-permissions.md) |
| The manifest, renders, re-anchoring | [05 Publishing and storage](implementation/05-publish-and-storage.md) |
| The viewer | [06 The viewer](implementation/06-viewer.md) |
| CLI commands | [07 The CLI and the skill](implementation/07-cli-and-skill.md) |
| Micro apps | [08 Micro apps](implementation/08-micro-apps.md) |
| Deploying and releases | [09 Deploying](implementation/09-deploy.md) |

## Agents: the library and the connector

Agents reach hosted work three ways, all ending in the same functions in `apps/server/src/library/` and the same `can()`: the CLI (`search`, `list`, `read`, `view`), the local `artifacts mcp`, and the hosted MCP at `/api/mcp`. The hosted one signs in through our own OAuth server (`apps/server/src/oauth/`). Rendering stays on the client: `artifacts pack` writes a publish to a folder, files go straight to the bucket, and the server commits by hash. [03](implementation/03-api.md#oauth-and-the-hosted-mcp) has the details.
