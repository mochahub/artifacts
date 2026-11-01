# Security

## Supported versions

Only the latest release gets security fixes. Upgrade with `artifacts upgrade`, which moves the CLI, the skill and, on Railway or Docker, the server. Migrations only add, so `artifacts upgrade --server --to <version>` can roll back one version if an upgrade goes wrong.

## Reporting a vulnerability

Report it privately with [GitHub's private vulnerability reporting](https://github.com/mochahub/artifacts/security/advisories/new). There is no email address for this. Please don't open a public issue or pull request for a vulnerability.

Include what you found, the version (`artifacts --version`, or `GET /api/health` on the server), and the steps to reproduce it. A proof of concept helps.

What to expect:

- We aim to reply within 7 days, to say we've seen it and whether we can reproduce it.
- This is a small project run by one maintainer, so these are aims and not promises.
- We'll keep you updated while we fix it. A fix ships as a new release, with a GitHub security advisory that credits you unless you'd rather it didn't.
- Please give us time to fix it before you publish details. We'd like 90 days at most.

## Threat model

This is what the design defends against and what it assumes. The contracts behind it are [04](docs/implementation/04-auth-and-permissions.md), [08](docs/implementation/08-micro-apps.md) and [09](docs/implementation/09-deploy.md). Nothing here is a guarantee beyond what the tests cover.

### What is untrusted

**Text agents read.** Comments, summaries, article text and notes can come from anyone who can write them, including guests on a share link. A model reading them through the CLI or the MCP could take them for instructions. Results from `search`, `list`, `read`, `status` and `comments` say that the text is data, and the skill says so too. That's a warning to the model, not a boundary: tokens stay limited to undoable actions either way.

**What `artifacts pull` writes.** A version's file list comes from whoever published it, so `pull` and `export` check every path, stay inside the target folder, verify every hash, and never write `lint.rules.js`, which the CLI would run. New publishes with a path outside the bundle are refused.

**Artifact code.** An artifact's HTML, CSS, JavaScript and backend are written by an agent, and may be wrong or hostile. The server never runs it in a place that holds a sign-in or a secret.

| Layer                       | What it does                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Content domain              | Bundle files are served from their own host (Live previews), which has no cookies and no access to the viewer's sign-in.                                                                                                                                                                                     |
| Path tokens                 | The content host is reached through a short-lived token in the path (2 hours, HMAC-signed). The token proves who the caller is. Access is checked again on every request, at most 5 seconds stale, so deleting an artifact or revoking a link stops open frames within seconds.                              |
| Fetch metadata              | Requests without `Sec-Fetch-Dest`, or with `document`, are refused, so a bundle can't be opened as a top-level page.                                                                                                                                                                                         |
| CSP `sandbox allow-scripts` | Every content response forces an opaque origin, even if someone opens the file directly. It can't register a service worker or read storage.                                                                                                                                                                 |
| Iframe                      | The viewer embeds frames with `sandbox="allow-scripts"` and never `allow-same-origin`. Data calls go through a `postMessage` bridge that accepts a message only from the iframe it created, and binds the artifact and version itself.                                                                       |
| Article HTML                | Markdown never keeps raw HTML. The CLI sanitizes articles, and the server sanitizes them again at commit with the same allowlist (no `script`, `style`, `iframe`, `foreignObject` or event attributes), because any token with `publish` could upload anything. The viewer loads only the re-sanitized copy. |
| Backends                    | Backend code runs in QuickJS compiled to WebAssembly, in child processes of the server. It has no network, no timers, no file system and no module loading. Its only binding is `env.DATA`, which reaches the artifact's own data folder.                                                                    |
| Sandbox processes           | The child has no secrets: it doesn't get the database URL, the bucket keys, `SESSION_SECRET` or `OPS_SECRET`. Its environment holds one variable, `BUN_BE_BUN=1`. Its only channel is IPC to the server, and the server checks every `env.DATA` call against the request in flight.                          |
| Limits                      | Per backend: 1 MB of code, 10 seconds a request, 64 MB of memory, request and response size caps, a bounded queue, and log caps.                                                                                                                                                                             |
| Data folder                 | Each artifact has one data folder in the bucket. Frontends reach it only through the viewer, and `me` data is keyed by a per-artifact pseudonym. Archived artifacts and view-only callers can't write.                                                                                                       |
| Uploaded files              | Stored files download as attachments unless they are images, audio, video or PDF. SVG always downloads, because it can carry script.                                                                                                                                                                         |

**Upload content.** Bundle files are stored by SHA-256. The server counts a hash as stored only after it has hashed the object itself, and presigned uploads carry `If-None-Match: *`, so nobody can put different bytes under a hash that a later publish would reuse.

### What the system protects

- **Secrets at rest.** Passwords use argon2id. Session, guest, invite, reset-link, share-link, device-code and CLI or organization tokens are stored as SHA-256 of the secret, and a secret appears once, in the response that creates it. Two values are stored as they are: the Web Push private key (`org.vapid_private`) and the pseudonym key (`org.pseudonym_key`). Anyone who can read the database can read them. They don't open any account.
- **Sign-in.** Passkeys require user verification. Passwords are 12 characters or more with rate limits per account and per IP. Cookies are `HttpOnly` and `SameSite=Lax`. Adding a passkey, changing a password, creating an organization token, approving the CLI and purging need a sign-in from the last 10 minutes.
- **CSRF.** A cookie-authenticated write needs an `Origin` that is one of the viewer origins.
- **One permission function.** `can()` decides every route, every content token and every `env.DATA` call. A generated test matrix covers roles, visibility and lifecycle.
- **The CLI.** A new machine signs in through a device flow, where a person types the code the CLI printed and sees the client, agent and IP before approving.
- **Agents do undoable things only, with exceptions.** A CLI token can archive, unarchive and move an artifact to Recently deleted, all of which a person can undo. It can't purge, resolve a thread, approve a version, change roles or settings, or approve a device. The exceptions are the data folder and backends. Default CLI tokens carry the `data` scope, so an agent can run `artifacts data clear` on an artifact it publishes, which erases its data folder for good, and a published backend can delete any key in it.

### What it assumes

- **Two registrable domains.** In production the viewer hosts and the content host must be different registrable domains (different sites). The server refuses to start if the content host is a viewer host, and logs a warning if they share a registrable domain. Railway's generated domains satisfy this, because `up.railway.app` is on the Public Suffix List. A content host that is a subdomain of a viewer domain weakens the isolation and is a misconfiguration.
- **HTTPS.** Passkeys need a secure context, and the session cookie is `Secure` on every HTTPS origin. The server leaves `Secure` off only on a plain-http viewer origin, so local setups can sign in. Don't serve a real deployment over http.
- **The internal ops port is never published.** Port 8082 serves `/internal/jobs/*`, behind `OPS_SECRET`, and is for operators and tests. The Docker image doesn't list it in `EXPOSE`, the Compose file doesn't map it, and on Railway no domain is attached. Keep it that way.
- **A reverse proxy in front.** The server takes the client address from the socket, or from the last `X-Forwarded-For` entry when the peer is a private address. Without a proxy in front, a client can vary that header to dodge per-IP rate limits.
- **Rate limits are in memory, per process.** With more than one replica, each replica counts for itself.
- **Everyone who can publish is invited.** The sandbox boundary is WebAssembly memory safety in Bun's engine, with the child process as a second layer. A backend can read every person's `me` data, which is why only the publisher, admins and members the publisher adds can publish. A hosted service for strangers would need a VM per tenant. This project doesn't claim to be that.
- **The bucket is private and honours conditional writes.** Every object is reached through the app or a presigned URL. Presigned GET links last a day and are stable within a UTC day, so anyone who holds one can use it until it expires.
- **No email.** The server sends none. Invite, reset and share links are copied by hand, and an invite link is a credential until it's used or expires (7 days).
- **Secrets are yours to keep.** `.env` holds `SETUP_TOKEN`, `SESSION_SECRET`, `OPS_SECRET` and the bucket keys. Rotating `SESSION_SECRET` signs everyone out and invalidates open content tokens, and nothing else.

### Known limits

These are recorded in [progress.md](docs/implementation/progress.md#known-gaps) and aren't vulnerabilities by themselves:

- A live-review stream can outlive lost access by up to 5 minutes. It carries no content, only that something changed.
- A device that was offline when its access ended keeps its offline copies until it next reaches the server.
- Backends that share a sandbox process can stall each other for up to 10 seconds, so one busy backend can slow others pinned to the same child.
- Web Push and the Railway path haven't been run end to end against the real services yet.
