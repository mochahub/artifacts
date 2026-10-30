# Implementation guides

These guides turn [SPEC.md](../SPEC.md) into something buildable. Read the spec first for **what** and **why**; read these for **how**. The building agent's brief is [HANDOFF.md](HANDOFF.md).

## Documents

| # | Document | Kind | Owns |
|---|---|---|---|
| 01 | [Repo and tooling](01-repo-and-tooling.md) | Guide | Layout, libraries, conventions, scripts, how to view the mocks |
| 02 | [Data model](02-data-model.md) | **Contract** | Table and column names, enums, derived status, bucket prefixes |
| 03 | [HTTP API](03-api.md) | **Contract** | Ports, paths, request and response shapes, headers, error codes, internal API |
| 04 | [Sign-in, callers and permissions](04-auth-and-permissions.md) | **Contract** | Caller types, cookie and token formats, scopes, permission actions and matrix, rate limits |
| 05 | [Publishing, rendering and storage](05-publish-and-storage.md) | **Contract** | Manifest schema, render outputs, block ids, re-anchoring, crops, clean-up |
| 06 | [The viewer](06-viewer.md) | Guide | Routes, screens per mock board, canvas engine, design rules |
| 07 | [The CLI and the skill](07-cli-and-skill.md) | **Contract** | Command names and flags, config files, credentials, lint rule ids, the skill |
| 08 | [Micro apps](08-micro-apps.md) | **Contract** | Bridge messages, data store rules and limits, the backend sandbox, request flow |
| 09 | [Deploying](09-deploy.md) | **Contract** | Images, environment variables, the Railway template, Compose, releases |
| 10 | [Testing and acceptance](10-testing-and-acceptance.md) | Guide | Test layers, fixtures, what the agent verifies versus the user |
| 11 | [Build order](11-milestones.md) | Guide | Spikes S1–S8, milestones M0–M11 |
| — | [Spike results](spikes.md) | Record | What each M0 spike found, and the design changes it caused |
| — | [HANDOFF.md](HANDOFF.md) | Prompt | The brief for the building agent |

Also in `docs/`:
- [hosting-evaluation.md](../hosting-evaluation.md): self-hosted versus a hosted service
- [backend-runtime-evaluation.md](../backend-runtime-evaluation.md): workerd versus Deno and others
- [`mocks/`](../mocks/): seven boards of viewer mocks
- [`review/`](../review/): the review canvas used to comment on the mocks

## When documents disagree

1. **Behaviour** (what happens, who may do what, what the user sees): SPEC.md wins.
2. **Names and shapes** (tables, columns, paths, fields, commands, variables, prefixes): the contract document that owns the name wins.
3. **Looks:** the mock boards win, except where a mock shows a forbidden pattern (06, "Design rules").
4. If something is still unclear, or two of these conflict in a way that changes behaviour, **ask the user**. Don't guess.

Fix the losing document in the same change, so the docs never drift.

## Glossary

| Term | Meaning |
|---|---|
| Organization | The one org per deployment, created by `artifacts setup` |
| Project | Usually one per repo; the first path segment |
| Artifact | One link, one manifest, versioned; has pages; may have a backend and a data folder |
| Version | An immutable publish of an artifact (`v5`) |
| Page | A part of an artifact: `canvas`, `article`, `prototype`, `gallery` (later `deck`) |
| Board | A canvas page's group of frames |
| Frame | One screen on a board, with a stable `data-frame` key |
| Block | A paragraph-level piece of an article, with a stable key |
| Thread | A comment and its replies, anchored to a frame point, a block or a quote |
| Fixed / resolved | An agent marks a thread fixed; only a person resolves it |
| Decision | Approve or Request changes, per version |
| Live previews | The content domain, where artifact code runs in sandboxed iframes |
| Try it | Swapping a frame's picture for its live page |
| Data folder | `data/<artifact id>/` in the bucket: an artifact's saved values and files |
| Sandbox | The QuickJS child processes of the app that run artifact backends |
| Home domain | The viewer domain that `artifacts setup` ran against; the passkey RP ID |
| Guest | Someone using a share link without an account |
| Recently deleted | Where deleted artifacts and versions wait 30 days before purge |
