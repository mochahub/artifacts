# Handoff prompt: build Artifacts

The prompt below is for the building agent's first message. It works for Claude Code or Codex, and assumes no memory of the design conversation. Copy the whole block.

````text
You're building **Artifacts**, an open-source, self-hosted system for publishing and reviewing what coding agents make: plans, research reports, design mocks and small interactive prototypes ("micro apps"). Any project's agent publishes with one CLI command and gets a permanent link. People review it on their iPhone or desktop, leave comments pinned to screens or passages, and the agent reads those comments, fixes the work, republishes and replies. Work from this repository's root. Nothing is built yet; the design is complete and approved for building.

## Read first, in this order

1. `docs/SPEC.md`: what Artifacts does and why. Sections 5 (viewer), 6 (review model), 7 (architecture, including 7.9 micro apps), 12 (phases) and 15 (decisions) matter most.
2. `docs/implementation/README.md`: the map of the implementation guides, which document owns which names, and what to do when documents disagree.
3. `docs/implementation/11-milestones.md`: the build order (spikes S1–S8, milestones M0–M11). M0 is done; its results and the design changes they caused are in `docs/implementation/spikes.md`.
4. The contract documents (02 data model, 03 API, 04 permissions, 05 publishing, 07 CLI, 08 micro apps, 09 deploy), as each milestone needs them.
5. The mocks: `docs/mocks/boards/*.html`, seven boards that are the visual source of truth (how to view them is below).

## Goal

Build **Phase 1 (M0–M8)**, then **Phase 2 (M9–M11)**, as vertical slices. Every milestone ends with working software, green tests and a short report. **Stop at each milestone boundary and check in with the user before starting the next.**

## Decisions already made (don't revisit without asking)

- **Hosting:** self-hosted, open source (MIT). Each team deploys its own copy. The supported platform is **Railway** (app service, Railway Postgres, Railway Storage Bucket). Docker Compose is the portable alternative. **Not Cloudflare**: no Cloudflare services or accounts anywhere.
- **Runtime:** **Bun** for the server and the CLI. TypeScript, Hono, Drizzle, Preact for the viewer.
- **The CLI is the entry point.**
  - `artifacts setup` deploys to Railway (by driving the Railway CLI), claims the server with `SETUP_TOKEN`, creates the owner, signs the machine in and installs the skill.
  - `artifacts upgrade` updates the CLI, the skill and the server.
  - `artifacts domain add` adds custom domains.
- **Sign-in:** email + password and **passkeys only**. No OAuth, no SSO.
- **No email:** the server never sends mail; invite, reset and share links are copied by hand.
- **Domains:** Railway's generated domains or custom ones both work. Passkeys carry across domains via WebAuthn Related Origin Requests, with a fallback.
- **Organization:** one per deployment. Roles are owner, admin, member and reviewer, plus outside accounts. Artifacts are visible to "Only me" or "Organization"; each artifact can be shared outside by person or by link (guests type a name).
- **The viewer is a website** (a PWA later), designed first for Safari on iPhone, then desktop. Not a native app.
- **Micro apps are central** and ship in Phase 2. An artifact is up to three parts:
  - a frontend: static files, sandboxed on a separate content domain
  - an optional **backend**: `fetch(request, env)` handlers in `api/`, versioned with the frontend, run in a **QuickJS sandbox** inside the app (child processes, one capped WebAssembly instance per backend; decided after spike S4, see `spikes.md`)
  - an optional **data folder** in the bucket: JSON values and files

  A backend can reach **only its own data folder**: no network, no secrets, for now.
- **Archive and delete:**
  - **Archive** is read-only, with links still working.
  - **Delete** goes to Recently deleted for 30 days, then purges.
  - **Agents** may only do undoable things; purging needs a person.
- **Defaults to use until the user says otherwise** (SPEC §15, items 8–13):
  - keep the reviewer role
  - keep every version forever
  - Preact
  - skip the Claude Code artifacts comparison test
  - publishers and admins can read people's `me` data, with a notice (**awaiting the user's confirmation**)
  - install via script plus npm

## Design rules (the user cares about these)

The look in the mocks is approved:
- a dark Figma-style canvas with a dot grid
- **yellow `#ffd84d` for a person's marks** (pins, highlights, open counts)
- **violet `#8f7cff` for an agent's changes** (versions, changed frames, agent replies)
- system serif titles, system UI text, translucent floating bars and sheets

The user explicitly rejected generic, "AI-generated" design patterns. Never use:
- a coloured accent bar down the edge of a card, thread or quote
- sparkle icons for AI or agents (agents sign with initials in a violet square: "Cl", "Cx")
- tinted pill backgrounds on word labels (labels are coloured words; only numeric counts get a filled badge)
- middle dots joining text ("A · B")
- "›" or "→" appended to link text
- gradient washes as decoration
- tinted callout boxes

Three details in the mocks are exceptions; don't copy them: the gradient under the guest landing photo (board 05), the `.fadeb` gradient under the tab bar in `kit.css`, and the middle dots in board captions (board labels, not product UI). When you're unsure, match the mock and leave out decoration. Write UI copy in plain, sentence-case words where a button says what happens.

## Constraints

- **Ask before anything billable or outward-facing:** deploying to Railway, creating Railway projects or templates, pushing images, publishing packages or releases, or anything else that spends money or publishes. Spikes S1 and S6 need the user's Railway account; prepare them and ask.
- **Never commit or push unless the user asks.** When asked, branch first if on `main`, and write plain-English commit messages.
- **Verify, don't assume.** Several claims come from documentation and were never run; they're listed as spikes S1–S8 in `11-milestones.md`. Run what you can locally first (S3 with SeaweedFS, S4, S5, S7, S8), write results to `docs/implementation/spikes.md`, and update the design documents if a result changes the design.
- **Keep the docs true.** If the code must differ from a contract document, update the document in the same change and tell the user.
- **Tests with the code:** the permission matrix (04) and the API tests (03) aren't optional.
- **What only the user can verify:** a real iPhone over cellular, passkeys on a device, real Railway costs, and the look. Prepare these checks and ask; don't claim them (10, "Acceptance").

## The mocks and the review canvas

- **Viewing the mocks:** run `cd docs && python3 -I review/server.py --port 8788`, then open `http://127.0.0.1:8788`. One board alone, for screenshots: `/board/<name>`.
- **On the phone:** the user reviews on their iPhone over Tailscale (`tailscale serve --bg --https=8788 http://127.0.0.1:8788`). Leave that to them unless asked.
- **Board → feature map:** `06-viewer.md` maps each board screen to features and routes.
- **Review comments:** stored in `docs/review/comments.json` (git-ignored), readable as Markdown at `/comments.md`.
  - All 8 current comments were answered and reflected in the mocks and spec; the user resolves them.
  - New comments from the user are instructions: read them at the start of each session.
- **Screenshot tool:** `docs/mocks/tools/shoot.mjs`. It needs a Playwright install; see `01-repo-and-tooling.md`.

## How to work

1. **Start with M0.** Run the local spikes and report the results. Ask the user to run, or allow you to run, the Railway and iPhone spikes.
2. **Then each milestone:** plan briefly, build, test, and update the docs if needed. Report:
   - what works
   - what you verified and how
   - what the user should check
   - what's next

   Then wait for the go-ahead.
3. **Prefer the boring, well-known option.** Few dependencies. No new services beyond the app, Postgres and the bucket.
4. **If documents conflict or something is ambiguous** in a way that changes behaviour, ask.

## Definition of done

- **Phase 1:** the acceptance list in `10-testing-and-acceptance.md` passes, including the user-run checks, which the user confirms.
- **Phase 2:** the same, for its own acceptance list.
````
