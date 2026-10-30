# Self-hosted vs hosted service: evaluation

Written 2026-10-29. This supersedes the recommendation in my previous reply, which said "build a hosted service" before I had checked what already exists.

> **Decision (2026-10-29, later the same day):** self-hosted, as recommended below, but on **Railway, not Cloudflare**, with **email + password and passkey** sign-in instead of Cloudflare Access, and the first owner created by `artifacts setup`. Also decided: Bun, MIT, no email (links are copied by hand), and Railway or custom domains, with passkeys working across both. The Cloudflare and Access details below are kept as the reasoning at the time. The current design is in [SPEC.md §7](SPEC.md) and §14.

## The options

1. **Use Claude Code artifacts.** Anthropic's built-in feature: Claude publishes pages to claude.ai and shares them; people comment, and Claude replies.
2. **Self-hosted, open source.** Each person or team deploys Artifacts into their own Cloudflare account with a "Deploy to Cloudflare" button. Cloudflare Access handles sign-in.
3. **Hosted service.** You run one multi-tenant service that anyone signs up for.
4. **Staged.** Build option 2 for yourself and your team now, structured so option 3 is a deployment change rather than a rewrite. Decide on hosting later, against evidence.

## What changed: the market already exists

**Claude Code artifacts** ([docs](https://code.claude.com/docs/en/artifacts)), available on Pro, Max, Team and Enterprise. What it already does:
- Claude publishes a page to claude.ai. It's private by default and updates in place, and each publish is a version.
- Sharing:
  - Team and Enterprise can share with specific people or the whole organization.
  - Anyone can share by public link; on Team and Enterprise an Owner must allow public sharing.
  - Team and Enterprise can make people editors.
- Comments, on artifacts shared within an organization:
  - Claude reads the threads and replies.
  - It can reply on its own when someone sends a comment to it.
  - It can only resolve threads a person sent to it.
- `/design` drafts artboards on one canvas, and `/slides` makes decks.
- For organizations: admin controls, retention settings and an audit log. Content loads from a sandboxed `claudeusercontent.com` origin.

**Its limits are where our design differs:**
- It's one HTML or Markdown page per artifact, and relative links don't resolve. There's no bundle of plan + research + mocks.
- Images must be embedded as data URIs, so every photo costs output tokens; the docs say so. Our CLI uploads files from disk at no token cost.
- External images are blocked, the size limit is 16 MiB, and scripts may only load from five CDNs.
- Comments only work when an artifact is shared within an organization, and people on a public link can't comment. On Pro and Max, with no organization, the comment loop appears unavailable. **Unverified:** I haven't tried this on a Pro or Max account.
- It's Claude only, on Anthropic's API, signed in with a claude.ai account. It's off by default in the Agent SDK, which is what runs this T3 session. That's why the CameraBuddy thread found no artifact tool. **Unverified:** whether it can be switched on here.
- The docs say to review `/design` canvases "in a desktop browser". They say nothing about mobile review, pins on frames, or comparing renders between versions.

**Independent services selling the same publish-and-comment loop** (claims are from their own pages):

| Service | What it offers | Price | Self-host |
|---|---|---|---|
| [display.dev](https://display.dev/) | One HTML or Markdown file per artifact, a stable URL, versions, comments the agent reads, company/private/public visibility, one-time-code guests | €0 / €15 / €49 per org per month, unlimited viewers | Not mentioned |
| [ShareCube](https://sharecube.io/) | MCP publishing, comments anchored to text, org roles, visibility policy, 4 MB limit | $0; $5–12 per month; Team $8 per seat | Enterprise only |
| [Artifacts Beam](https://github.com/JeffreySun/artifacts-beam) | A skill for Claude Code, Copilot CLI and Codex, versions with diff, link expiry and passcodes | Not stated | No (MIT client, hosted server) |
| [share/artifacts](https://shareartifacts.dev/) | MCP publishing of static HTML | Not checked | Not checked |

None of these mention what the CameraBuddy thread valued most:
- a pan-and-zoom canvas of device frames on a phone, with pins on frames
- multi-page bundles (plan, research and mocks behind one link)
- rendering in iPhone Safari's engine, with lint checks and a pixel comparison between versions

That gap is real, but it's narrow. A platform that already owns the agent (Anthropic) could close it with one release.

## Scorecard

Scores are for your situation: a solo builder who wants this for your own projects and your team first.

| | 1 · Claude Code artifacts | 2 · Self-hosted | 3 · Hosted service | 4 · Staged (2 → 3) |
|---|---|---|---|---|
| Time until you use it | Today, but only from Claude Code with a claude.ai login | MVP | MVP plus auth, tenancy, abuse and legal work | MVP |
| Setup for a new team | None | Deploy button, a domain, an Access policy (about 15 min) | Sign up | Deploy button now; sign-up if hosting launches |
| Teams, invites, private by default, external sharing | Team and Enterprise plans only | Yes: Access signs people in, the app decides what they can see | Yes, but you build the sign-in | Yes |
| Works with Codex, T3 and any agent | No | Yes | Yes | Yes |
| Multi-page bundles, image files with no token cost | No | Yes | Yes | Yes |
| Mobile canvas review with pins on frames | No evidence | Yes (what we mocked) | Yes | Yes |
| Your ongoing operations | None | Low: you run your own copy; others run theirs | High: uptime, support, abuse, takedowns, privacy requests, billing | Low now; high only if you choose to host |
| Infra cost to you | Your Claude plan | About $0–5 a month | $5 a month plus R2 storage; your time is the real cost | About $0–5 a month |
| Cost to a user | A Claude plan; Team plan for comments | $0–5 a month in their Cloudflare account | Your pricing | Their Cloudflare account |
| Users' control of their data | Anthropic's servers | Their own account | Your servers | Their account |
| Revenue potential | None | None directly | Modest: competitors price at €0–49 per org, $5–8 per seat | Kept open |
| Exposure to competitors | — | Low: it's a tool, not a business | High: four startups plus the platform owner | Low, until you choose to compete |

## Why self-hosting is easier than it was

- **One-click deploys.** A Deploy to Cloudflare button clones the repo into the user's GitHub. It creates the D1 database, R2 bucket and Durable Objects automatically, and sets up CI. (Verified in Cloudflare's docs.)
- **Sign-in is solved by Access.** Cloudflare's Zero Trust features are free for up to 50 users, and Access signs anyone in with a one-time email code, Google or GitHub. The app reads the signed-in email from Access's token and does its own permission checks: workspaces, roles, visibility and external invitees. Teams, invites and "private to me or to the team" keep the same rules as the hosted design; only *who verifies the email* changes.
- **External link sharing needs no sign-in.** Share links skip Access and are checked by the app, so outside link viewers don't use one of the 50 seats. External people invited *by email* do sign in through Access and use a seat.
- **Costs.** R2 gives 10 GB free, then $0.015 per GB-month, with no egress fees. Sending invite emails from the app needs Workers Paid ($5 a month); without it, an admin copies the invite link instead.

## Why a hosted service is harder than it looks

These are on top of the product itself, and none of them make reviews better:
- **Your own sign-in.** Accounts, sessions, email verification, device-code login for the CLI, password-less links, and later SSO.
- **Isolation between customers.** A data layer that scopes every query, a permission test matrix, and per-workspace storage.
- **Abuse.** A free host for HTML and JavaScript with shareable links attracts phishing. You need quotas, reporting, a takedown process, and a separate content domain so a Safe Browsing flag doesn't take down the app.
- **Trust and legal.** Terms, a privacy policy, deletion and export, security questionnaires from teams who'd publish unreleased plans.
- **Operations.** Uptime, support, backups and billing.

Given the competitors, pricing would also sit near €15–49 per org or $5–8 per seat. That's a small margin for that much work.

## Recommendation: option 4, staged

1. **Build the self-hosted version first, for you and your team.** Open source, a Deploy to Cloudflare button, Cloudflare Access for sign-in, and the app's own rules for workspaces, roles, visibility and external sharing. That covers every requirement you listed this week, without the hosted-service burden.
2. **Keep the hosted option cheap to reach later:**
   - Keep `workspace_id` on every row and file, and route every request through one permission check.
   - Put sign-in behind a small adapter: "Access token" now, "own accounts" later.
   - Keep the CLI and skill pointed at a configurable server URL.
   - Then hosting is a deployment and sign-in change, not a rewrite.
3. **Decide on hosting with evidence, in about three months:**
   - Do people outside your circle deploy it or ask for a hosted version?
   - Have Claude Code artifacts, or the startups, closed the gaps: mobile canvas review, multi-page bundles, agent-agnostic publishing?
   - If the gap still holds and people are asking, launch hosted. If not, you still have the tool you wanted.

**A test worth 30 minutes first.** Publish the CameraBuddy roadmap through Claude Code artifacts from a normal Claude Code CLI session, not T3, and comment on it from your phone. If that covers what you need, you may not need to build the hosting part at all. Even then, the kit, the lint and render gate, and the skill would still be useful on top of it. If it falls short (single page, image token cost, no mobile pins, no Codex), you'll know exactly why you're building this.
