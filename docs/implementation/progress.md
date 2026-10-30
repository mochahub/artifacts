# Progress: building M2–M11

A fresh agent can resume from this file alone. Read [HANDOFF-M2-M11.md](HANDOFF-M2-M11.md) for the brief, then this.

## Status

| Milestone | Branch | Last commit | CI |
|---|---|---|---|
| M0 Spikes | `main` history | `fafc2f6` | n/a |
| M1 Foundations | `m1-foundations` | `9de1ffc` | green (run 41045711327) |
| M2 Sign-in and CLI skeleton | `m2-sign-in` | in progress | |
| M3–M11 | not started | | |

## Verified

- **M1 fixes (2026-10-30):** `bun run lint` clean, `bun run test` 79 pass, `bun run e2e` 6 pass locally. CI green on `9de1ffc`.

## Decisions to review

1. **M2, Docker image before M8.** `setup --docker` needs an image that can't be pushed yet, so `apps/server/Dockerfile` came forward from M8 and `--image`/`ARTIFACTS_IMAGE` overrides the default `ghcr.io/mochahub/artifacts:<version>`. To change: nothing needed once images are released.
2. **M2, `Secure` cookies.** Left off only on plain-http viewer origins, or local Compose and e2e couldn't sign in. HTTPS origins always get it. To change: `isSecureRequest` in `apps/server/src/auth/sessions.ts`.
3. **M2, tokens and invites.** 04 said no token manages people, but SPEC §10 has `artifacts org invite` and `org reset-link`. SPEC wins on behaviour: a new action, `people.invite`, lets an admin's CLI token print those links. Role changes and removal stay people-only. To change: drop `people.invite` from `canOnOrg` and remove the CLI commands.
4. **M2, the "Approve the CLI?" copy.** Board 06 says "Can't invite, share outside or change settings", which isn't true: the CLI shares, and an admin's invites. The page says "Can't resolve threads, approve versions or delete anything for good", which is. To change: `apps/viewer/src/routes/device.tsx`.
5. **M2, member added with `view`.** 04 lists members as commenters, but that would make `view` meaningless on a private artifact, so `view` wins. To change: `mayComment` in `can.ts`.
6. **M2, org tokens need `read` to publish.** 04's actions apply "after visibility", so a CI token needs `read` and `publish`, and can't reach `me` artifacts. Org tokens can't comment, as 04's table says, so a CI agent can't reply. To change: `mayComment` and `seesArtifact`.
7. **M2, Keychain fallbacks.** 07 listed `security`, `secret-tool` and PowerShell fallbacks. `Bun.secrets` already uses those stores, so the CLI goes straight to the 0600 file if it throws. To change: `packages/cli/src/credentials/index.ts`.
8. **M2, client IP.** Taken from the socket, or from the last `X-Forwarded-For` entry when the peer is a private address (Railway, a local proxy). Without a proxy in front of Compose, a client could vary that header to dodge per-IP limits. To change: `clientIp` in `server.ts`.
9. **Screenshots** go in `docs/mocks/shots/<board>-<screen>-<name>.png`, written by the e2e run.

## Needs you

Gathered as each milestone is reached. So far, from the brief:
1. **Safari and presigned GETs:** on an iPhone, open an artifact, reload, and check in Web Inspector that images come from cache on the same day.
2. **S1 templates:** `railway templates create` and `railway deploy --template` (spikes.md).
3. **S2:** desktop Chrome, and the "Sign in on the home domain" fallback.
4. **Windows:** the CLI, including credentials, is untested.
5. **SPEC §7.5 cost table:** measure on the first real deploy.

## Known gaps

- **Reauth with a passkey** arrives in M6; until then `POST /api/auth/reauth` takes a password.
- **The reauth sheet** has no e2e test yet, because the e2e server's clock can't be moved. The API side is tested.
