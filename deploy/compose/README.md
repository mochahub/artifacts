# Running it with Docker Compose

`docker-compose.yml` is what `artifacts setup --docker` writes next to a generated `.env`. The other two files are for developing Artifacts itself: `docker-compose.dev.yml` and `docker-compose.test.yml` use public credentials and must never face a network.

## Before you let anyone in

- **HTTPS.** Passkeys and `Secure` cookies need it, except on `localhost`. Put a reverse proxy on the same machine in front of the three ports (Caddy example in the top-level README), then set `PUBLIC_URL`, `CONTENT_URL` and `S3_PUBLIC_ENDPOINT` in `.env` to the proxy's addresses and run `docker compose up -d`.
- **A separate domain for Live previews.** `CONTENT_URL` must be on a different registrable domain from the viewer's, or artifact code runs on the same site as everyone's sign-in. The server warns at boot if it isn't.
- **Ports.** Everything is published on `127.0.0.1` (`BIND_ADDRESS` in `.env`), so only the proxy reaches it. Proxy these: the viewer (`VIEWER_PORT`, 8080), Live previews (`LIVE_PORT`, 8081) and the bucket (`S3_PORT`, 8333, because presigned URLs go straight to it). Postgres and the app's operators' port (8082) are never published; leave them that way. If you set `BIND_ADDRESS=0.0.0.0`, firewall these ports yourself.
- **Secrets.** They live in `.env` (mode 0600) and nowhere else: the app and Postgres read them from it, and so does SeaweedFS, as its S3 key pair. Keep it out of git and back it up somewhere private. If it leaks, change `SESSION_SECRET` (everyone signs in again) and the S3 key pair, then `docker compose up -d`. Anyone in the `docker` group can read them with `docker inspect`; treat that group as root.
- **Backups.** `pg_dump` from cron and a copy of the bucket (the top-level README, "Backups"). Try a restore once.
- **Upgrades.** `artifacts upgrade --server` changes `ARTIFACTS_IMAGE` in `.env` and runs `docker compose up -d`. The images are pinned, so nothing changes until you do that. The Postgres image is `postgres:17`: a new major version needs a dump and restore, not a tag change.

## What the file does for you

Every container drops capabilities, can't gain privileges, has a read-only root filesystem, memory and process limits, and logs capped at 30 MB. The app runs as a non-root user. The limits (1 GB and 2 CPUs each) are ceilings; raise them in the file if you publish large images or run many Live previews.
