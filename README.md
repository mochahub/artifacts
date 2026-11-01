# Artifacts

Self-hosted publishing and review for what coding agents make: plans, research, design mocks and small apps. An agent publishes with one command and gets a permanent link. People review it on a phone or desktop and pin comments to screens or passages. The agent reads those comments, fixes the work, publishes again and replies.

![The Artifacts viewer on desktop and phone. A pinned comment on a mock of a camera app, with the agent's reply marking it fixed in v2.](docs/images/hero.jpg)

MIT licensed. It needs a container host, Postgres and an S3-compatible bucket.

## How it works

An agent runs `artifacts publish`. The CLI checks the work, renders each screen in WebKit, and uploads only the files the server doesn't have. The server stores them by hash in a bucket and records a new version in Postgres. People open the link in a viewer made for phones, and pin comments to a screen or a passage. The agent reads the open comments with `artifacts comments`, fixes the work, publishes again and replies. Comments follow the work across versions. Artifact code runs on a separate domain, in a sandbox, so it can't read anyone's sign-in. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the diagrams.

![Four phone screens from one review: a new version waiting in the inbox, a comment pinned to a screen, a quoted passage in a research page, and a compare view outlining the two regions that changed.](docs/images/review-loop.jpg)

## Connect an agent from anywhere

The skill and the CLI cover agents on a machine with them installed. For remote boxes, Artifacts is also a hosted MCP server at `<your server>/api/mcp`, which signs in with your Artifacts account:

```sh
artifacts mcp install                       # Claude Code and Codex, opt-in
claude mcp add --transport http artifacts https://art.example.com/api/mcp
```

It can search, read and view hosted work, read comments, reply and publish. On a box with no sign-in, a CLI token in an environment variable works too: `artifacts mcp install --token-env ARTIFACTS_MCP_TOKEN`. Publishing a canvas still needs the CLI and WebKit on that box, because rendering happens on the client: `artifacts pack` does it, and needs no sign-in.

## Requirements

- A machine for the server that runs Docker containers, or a Railway account.
- Postgres. Railway and the Docker setup both provide it, and the Docker setup runs 17.
- An S3-compatible bucket that supports conditional writes (`If-Match` and `If-None-Match`). Railway's bucket and SeaweedFS, which the Docker setup uses, both do.
- HTTPS in front of the server, except on `localhost`. Passkeys and `Secure` cookies need it.
- Two domains on different registrable domains, one for the viewer and one for Live previews. Railway's generated domains already are.
- On the machine that publishes: macOS, Linux or Windows. Linux needs WebKit's system libraries, and `artifacts doctor` prints the command. Windows is untested.
- To work on the code: Bun (the version in `.bun-version`) and Docker.

## Install

```sh
curl -fsSL https://github.com/mochahub/artifacts/releases/latest/download/install.sh | sh
```

Or `bun add -g @artifacts/cli`, once a release has been published to npm. Nobody needs Bun or Node for the binary. WebKit downloads the first time you render.

## Set up

```sh
artifacts setup
```

This deploys to Railway (app, Postgres and a bucket), claims the server, makes you the owner, signs this machine in and installs the skill for Claude Code and Codex.

**Docker, on a machine you run:**

```sh
artifacts setup --docker --dir ~/artifacts-server
```

This writes `docker-compose.yml` and `.env` with generated secrets, starts everything, and claims it. Ports: 8080 (viewer), 8081 (Live previews), 8333 (bucket), published on `127.0.0.1` only, for a reverse proxy on the same machine. To reach them from elsewhere without a proxy, set `BIND_ADDRESS=0.0.0.0` in `.env` (see [deploy/compose/README.md](deploy/compose/README.md)).

**An existing server:** `artifacts setup https://art.example.com` claims it if it's new, and signs you in if it isn't. The CLI only signs in over HTTPS (plain `http://` is accepted only for `localhost`), so a server needs the proxy below first.

### HTTPS

Passkeys and `Secure` cookies need HTTPS, except on `localhost`. Put a reverse proxy in front, with a separate registrable domain for Live previews, so artifact code can't read anyone's sign-in. With Caddy:

```
art.example.com {
  reverse_proxy 127.0.0.1:8080
}
art-previews.example.net {
  reverse_proxy 127.0.0.1:8081
}
bucket.example.net {
  reverse_proxy 127.0.0.1:8333
}
```

Then in `.env`, set `PUBLIC_URL`, `CONTENT_URL` and `S3_PUBLIC_ENDPOINT` to those addresses, and run `docker compose up -d`.

## Use it

```sh
artifacts init            # a working folder in .artifacts/work/, with the kit
artifacts lint            # overlap, clipping, safe areas, contrast, determinism
artifacts render          # look at .artifacts/contact-sheet.png
artifacts publish -m "First draft"

artifacts status          # the latest decision and open comments
artifacts comments --open --json
artifacts reply 3 "Moved it above the strip" --fixed
```

Invite people with `artifacts org invite sam@example.com`, which prints a link to send yourself. The server never sends email.

## Upgrading

`artifacts upgrade` updates the CLI and the skill, and moves the server to the new release if you run it on Railway or Docker. Migrations only add, so `artifacts upgrade --server --to <version>` rolls back one version.

## Backups

- **Postgres** holds people and review data. On Docker, back it up from cron:

  ```sh
  docker compose exec -T postgres pg_dump -U artifacts artifacts | gzip > "artifacts-$(date +%F).sql.gz"
  ```

  On Railway, check what your plan includes.
- **The bucket** holds files. They're content-addressed and immutable, apart from `data/`, so a copy of the bucket is a backup.
- **`.env`** holds your secrets. Keep a copy somewhere safe.

## Development

```sh
bun install
bun run dev      # Postgres, SeaweedFS, the server and Vite
bun run test     # unit, permission and API tests (needs Docker)
bun run e2e      # Playwright in WebKit (needs Docker)
bun run lint
```

The design lives in [docs/SPEC.md](docs/SPEC.md) and [docs/implementation/](docs/implementation/README.md).

## Security

To report a vulnerability, and for what the design defends against, see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits are Conventional Commits, and they set the release.

## License

[MIT](LICENSE).
