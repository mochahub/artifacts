# 09 · Deploying: images, variables, Railway template, Docker Compose, releases

**Contract document** for environment variables, ports, images and the template. Behaviour comes from SPEC §7.4–7.6.

## Images

| Image | Built from | Contains |
|---|---|---|
| `ghcr.io/<org>/artifacts:<semver>` | `apps/server/Dockerfile` | Bun runtime, the server, the built viewer (`apps/viewer/dist`), Drizzle migrations, sharp |

`apps/server/Dockerfile` (sketch):
```dockerfile
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /src/apps/server/dist ./ 
COPY --from=build /src/apps/viewer/dist ./public
COPY --from=build /src/apps/server/drizzle ./drizzle
RUN echo '{"private":true}' > package.json && bun add sharp@0.35.5 quickjs-emscripten@0.32.0   # loaded at runtime, so not bundled
ENV NODE_ENV=production PORT=8080 CONTENT_PORT=8081 INTERNAL_PORT=8082
EXPOSE 8080 8081 8082
HEALTHCHECK CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1))"
CMD ["bun", "server.js"]
```

Pin exact Bun and `quickjs-emscripten` versions in the repo (`.bun-version`, the lockfile). Images are multi-arch (amd64, arm64).

## Boot sequence (app)

1. **Read and validate the environment** (below). Exit with a clear message on errors:
   - a bad URL
   - the content host equal to a viewer host
   - the content host sharing a registrable domain with a viewer host (a warning, not an error)
2. **Migrate:** run Drizzle migrations under `pg_advisory_lock`, so only one replica migrates.
3. **First boot only:** if `org` is absent, enter setup mode. Generate VAPID keys if missing (Phase 2). If `org` exists, exit if `CONTENT_URL`'s host is the home domain.
4. **Bucket:** `HeadBucket`, and create the bucket only on a 404 (Compose). Any other failure logs a warning and boot continues, so a key that can't call `HeadBucket` doesn't stop the app.
5. **Listen** on the three ports (03).
6. **Start jobs** (05 clean-up, usage recount, log expiry) on timers, guarded by advisory locks.

## Environment variables

**App service (`artifacts`):**

| Variable | Required | Example | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgres://…` | Railway: `${{Postgres.DATABASE_URL}}` |
| `S3_ENDPOINT` | yes | `https://…` | Railway bucket endpoint; SeaweedFS `http://seaweedfs:8333` |
| `S3_REGION` | yes | `auto` | |
| `S3_BUCKET` | yes | `artifacts-…` | |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | | Railway bucket credentials (variable names on the bucket: spike S1) |
| `S3_FORCE_PATH_STYLE` | no | `true` | Default `true` |
| `S3_PUBLIC_ENDPOINT` | no | | If presigned URLs must use a different host than the app uses (SeaweedFS behind a proxy) |
| `PUBLIC_URL` | yes | `https://artifacts-production.up.railway.app` | Domain used in copied links |
| `MORE_URLS` | no | `https://art.zahin.ca` | Comma-separated extra viewer origins |
| `CONTENT_URL` | yes, for Live previews | `https://artifacts-content-production.up.railway.app` | The Live previews origin. On Railway no variable holds the second generated domain (`RAILWAY_PUBLIC_DOMAIN` is only the first; spike S1), so `artifacts setup` reads it with `railway domain list --json` and sets it with `railway variable set` before claiming. The server starts without it: Live previews are off and `GET /api/meta` reports `contentUrl: null` until it's set. Setup mode still means only "no `org` row" (04). |
| `SETUP_TOKEN` | yes | 32+ random chars | Template variable function; not sealed (SPEC §7.4) |
| `SESSION_SECRET` | yes | 64 random chars | Keys for content tokens (HKDF, info `"content"`). Caller pseudonyms use `org.pseudonym_key` instead (02). |
| `OPS_SECRET` | yes | 64 random chars | For `/internal/jobs/*` |
| `PORT`, `CONTENT_PORT`, `INTERNAL_PORT` | no | 8080, 8081, 8082 | Must differ (boot refuses otherwise). A viewer URL that is plain http away from localhost, or an `OPS_SECRET` reused as another secret, is logged as a warning. |
| `LOG_LEVEL` | no | `info` | JSON logs to stdout |
| `GITHUB_RELEASES_REPO` | no | `mochahub/artifacts` | For the "new version available" notice in Settings. `none` turns it off. A private repo: no notice. |


**Rotating `SESSION_SECRET`** signs everyone out and invalidates open content tokens (short-lived). Nothing stored depends on it, so it's safe to rotate after a suspected leak. `org.pseudonym_key`, in Postgres, is never rotated, because `me` data is keyed by pseudonym.

## Railway template (`deploy/railway/`)

| Service | Source | Domains | Variables | Settings |
|---|---|---|---|---|
| `artifacts` | Image `ghcr.io/<org>/artifacts:<v>` (pinned) | Two generated domains: port 8080 (viewer), port 8081 (content) | As above, wired with `${{…}}` references; `SETUP_TOKEN = ${{secret(48)}}`, `SESSION_SECRET = ${{secret(64)}}`, `OPS_SECRET = ${{secret(64)}}` | Health check `/api/health`; Serverless **off** |
| `Postgres` | Railway Postgres | none | | |
| `bucket` | Railway Storage Bucket | none | | |

**Unverified until spike S1** (template features to confirm in Railway's template editor):
- two generated domains on one service via target ports
- referencing the bucket's credentials as variables
- a template variable function for secrets on the image service
- that `railway deploy --template` provisions a template that includes a bucket into an existing project

`deploy/railway/README.md` records the template code, how to publish it (`railway templates publish`), and how to update it for a release (bump the image tag).

## Docker Compose (`deploy/compose/`)

`docker-compose.yml`: `artifacts`, `postgres:17`, `chrislusf/seaweedfs:4.50` (pinned; `weed server -s3` with an `s3.json` of keys generated into the folder, plus explicit `-master.volumeSizeLimitMB` and `-volume.max`, because weed otherwise derives the volume count from free disk and a small disk gets none; the app creates its bucket at boot if missing). `artifacts setup --docker` writes it with `.env`. Ports:
- `8080`: the viewer
- `8081`: content
- `8333`: the bucket, because presigned URLs go straight to it (`S3_PUBLIC_ENDPOINT`). On a remote machine, change `S3_PUBLIC_ENDPOINT` in `.env` to an address clients can reach.

Put a reverse proxy (Caddy example in the README) in front for HTTPS. Passkeys and `Secure` cookies need HTTPS, except on `localhost`.

## Releases (`.github/workflows/`)

1. **`ci.yml`, on every push, on a Blacksmith runner (`blacksmith-4vcpu-ubuntu-2404`):**
   - `bun install`, typecheck, Biome lint
   - unit tests
   - API tests against Postgres and SeaweedFS, started from `docker-compose.test.yml` (SeaweedFS needs a command and a mounted key file, which `services:` can't give it)
   - viewer size budget
   - Playwright WebKit e2e at iPhone size
2. **`release.yml`, by itself after green CI on `main`, or by hand for a minor or major:**
   - skip if only docs or workflows changed since the last release (automatic runs only)
   - next version from the latest tag, stamped at build time; nothing is committed
   - build CLI binaries for 5 targets, with SHA-256 sums
   - run `artifacts setup --docker` with the new binary against the new image
   - build and push the image (multi-arch) to GHCR
   - create the GitHub Release and its tag, with `install.sh`
   - publish `@artifacts/cli` to npm if the repo has an `NPM_TOKEN` secret

   A push to any other branch that changes the workflow runs it all without publishing.
3. **Manual:** bump the template's image tags and republish the template. `artifacts upgrade --server` already works without it; the template only matters for new deploys.

Semver; the server declares `minCliVersion`. Breaking API changes bump the minor version while below 1.0, the major after.

## Operations

- **Logs:** JSON lines (`level`, `msg`, `requestId`, `route`, `ms`, `status`). Railway shows them.
- **Backups:** Railway Postgres backups depend on the plan. **Unverified:** check what Hobby includes, and document a `pg_dump` cron in the README for Docker. Bucket objects are content-addressed and immutable (data excepted), so a bucket copy is a backup.
- **Upgrades:** `artifacts upgrade --server` (07). Migrations only add (02), so rolling back one version works.
