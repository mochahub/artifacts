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

None yet.

## Needs you

Gathered as each milestone is reached. So far, from the brief:
1. **Safari and presigned GETs:** on an iPhone, open an artifact, reload, and check in Web Inspector that images come from cache on the same day.
2. **S1 templates:** `railway templates create` and `railway deploy --template` (spikes.md).
3. **S2:** desktop Chrome, and the "Sign in on the home domain" fallback.
4. **Windows:** the CLI, including credentials, is untested.
5. **SPEC §7.5 cost table:** measure on the first real deploy.

## Known gaps

None yet.
