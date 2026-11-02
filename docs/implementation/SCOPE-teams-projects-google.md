# Scope: teams, project access and Google sign-in

**Status: proposal. Nothing here is built.** Based on `origin/main` at `5400f6e`. Multi-org stays out: a second organization is a second deployment.

## The goal

1. People can belong to any number of teams inside an organization.
2. Anything can be shared with a team, at artifact or project level.
3. Projects can be restricted to chosen people and teams.
4. Google sign-in is optional, and can be set up during setup or later in Settings.

It should stay explainable in one breath:

> A project is open to the organization or restricted. Add people or teams to give them a level. Reviewers and outside people never go above commenting. Admins see everything.

## The model

### Who can do what

Checked in this order, and the first that applies wins:

| # | Rule | Result |
|---|---|---|
| 1 | Owner or admin | Everything, including restricted projects and `me` artifacts |
| 2 | Publisher of the artifact, or a member with `manage` on its project (for `org` artifacts) | Manage the artifact |
| 3 | Added directly to the artifact | Exactly that level, as today |
| 4 | Anything else | The highest of: role in an open project, project grants, team grants on the artifact |

The role cap applies to every grant, including rule 2: reviewer and outside stop at `comment`, so a reviewer given project `manage` can comment and no more.

- **Rule 3 keeps today's behaviour.** A direct `view` row can already lower someone (04). It's also the one way to narrow a single person without deny rules.
- **`me` stays private.** Project grants only reach `org` artifacts. A `me` artifact is seen by its publisher, admins, and whoever is added to that artifact directly or by team.
- **There are no deny rules.** Grants only add, apart from rule 3.
- **Tokens stay narrower than their person.** Project `manage` works in a browser session only. A CLI token still manages only artifacts its person published, and gets no "publish to any artifact". Otherwise an agent could ship a backend into a teammate's artifact and read everyone's `me` data.

### Levels

| Level | On a project | On an artifact |
|---|---|---|
| Can view | See its `org` artifacts | See it |
| Can comment | Also comment, approve and resolve | Same |
| Can publish | Also add **new** artifacts | Also publish new versions |
| Can manage | Also publish to any artifact, archive and delete, and change who has access | Not offered: the publisher and project managers hold this |

Project "Can publish" doesn't allow new versions of other people's artifacts. A new version can carry a backend, and a backend can read every person's `me` data (04). That right stays with the publisher, a direct `publish` grant, or project `manage`.

### Open and restricted projects

- `projects.restricted` defaults to `false`, so every existing project stays as it is.
- `visibility` keeps `me | org`. `org` now means "everyone who can see this project". In an open project that's the whole organization, so nothing changes.
- A restricted project is visible only to admins, its grant holders, publishers of artifacts in it, and people added to one of its artifacts. Those last two see only those artifacts.
- `org.settings.defaultProjectAccess` (`org` or `restricted`, default `org`) sets what a new project starts as. The default must be a schema default, so stored settings without the key still parse.
- Whoever creates a project gets `manage` on it, recorded in `project_access`.

## Data model

All additive, with `org_id` on each new table. No data migration.

```text
teams            id, org_id, slug, name, description, created_by, created_at
                 unique (org_id, slug)
team_members     team_id, person_id, org_id, role (lead | member), added_by, created_at
                 primary key (team_id, person_id)
project_access   id, org_id, project_id, person_id?, team_id?, permission, granted_by, created_at
                 check: exactly one of person_id and team_id
                 unique (project_id, person_id), unique (project_id, team_id)
artifact_team_access
                 artifact_id, team_id, org_id, permission, granted_by, via_token, created_at
                 primary key (artifact_id, team_id)

new enum         project_permission: view | comment | publish | manage
projects         + restricted boolean default false, + created_by uuid null,
                   + created_by_token uuid null
invites          + project_id, project_permission, team_ids, all nullable
activity_kind    + team_created, team_deleted, team_member_added, team_member_removed,
                   project_access_changed, identity_linked
```

`artifact_access` stays as it is. Its key is `(artifact_id, person_id)` with a required `person_id`, so widening it to teams wouldn't be additive. Projects made before this have no `created_by`, so admins manage them until someone is granted `manage`.

## Changing `can()`

`can()` stays pure and stays the one check. Its callers don't change. The resource gains two required fields:

```ts
type ArtifactResource = {
  // ...existing fields, with `access` still the direct rows
  restricted: boolean;
  /** The token that created this project, if any. See "Org tokens". */
  projectTokenId: string | null;
  /** One row per person, expanded from teams. `confirmed` is the best level a person granted. */
  inherited: { personId: string; level: ProjectPermission; confirmed: ProjectPermission | null; sources: GrantSource[] }[];
};
```

Expanding at load time, not on the caller, is deliberate:

- Only two places build a resource: `toResource` in `api/artifacts-db.ts` and `visibleTo` in `library/visible.ts`. Required fields make the compiler flag both, and the permission test.
- The content-port recheck and push notifications build callers by hand. `push/notify.ts` checks many people against one resource, so a resource that already holds everyone's grants needs no per-person query.
- `visibleTo` loads only the caller's rows, so lists stay at one query per concern. `toResource` loads everyone's. `/api/activity` calls it for up to 200 rows, so add that case to `load-notes.md`.

In `can.ts`: `seesArtifact`, `mayComment`, `mayPublish`, `mayManage` and `commentOnlyFromTokenGrant` read `inherited` after `access`. A shared `effective(person, artifact)` applies the rules and role cap above, so they can't drift apart.

**`via_token` carries over.** Only `artifact_team_access` needs it, because tokens can't touch teams or project access at all. Keeping `level` and `confirmed` apart matters: if a token-made team grant and a person-made project grant tie at `comment`, the person can still decide. `commentOnlyFromTokenGrant` passes when any source, direct or inherited, gives a confirmed right to comment.

**Org tokens.** `project_ids = null` means every open project. A restricted project must be named on the token. Restricting a project therefore takes it away from broad tokens, and that failure is visible. A token always reaches a project it created itself (`projects.created_by_token`), or CI publishing would fail on its second run when `defaultProjectAccess` is `restricted`. Admins manage those projects, since no person created them.

### New actions

| Action | Who |
|---|---|
| `team.read` | Members and up; cliToken with `read` |
| `team.manage` (create, rename, delete) | Admins, owner, as people |
| `team.members` | Team leads, admins, owner, as people |
| `project.access.read` | `manage` on the project, admins, owner |
| `project.access.write`, `project.update` | Same, as people. Never a token. |
| `project.publish` | Members and up in an open project; `publish` or above in a restricted one; tokens as their person; org tokens by project |
| `people.search` | Members and up, as people. New: today only admins can list people, and a picker needs this. |

Each needs a route test and a row in `permissions.test.ts`, per `CONTRIBUTING.md`.

### Routes

```text
GET    /api/teams                         POST   /api/teams
GET    /api/teams/:slug                   PATCH  /api/teams/:slug
DELETE /api/teams/:slug
PUT    /api/teams/:slug/members/:personId DELETE /api/teams/:slug/members/:personId
GET    /api/people/search?q=
GET    /api/projects/:slug/access         PATCH  /api/projects/:slug/access   (restricted on or off)
PUT    /api/projects/:slug/access/:subject
DELETE /api/projects/:slug/access/:subject
PUT    /api/artifacts/:id/teams/:teamId   DELETE /api/artifacts/:id/teams/:teamId
```

`GET /api/artifacts/:id/access` grows to return teams and inherited rows with their source, so the UI can say why someone has access.

## What follows and what needs work

**Follows with no change.** Everything that starts from `visibleTo` or `can()`: home, search, the library, MCP tools, `/api/activity`, file and render routes, the content recheck and push. Looking a project up by `repo` is safe too: `scopedProjects` only narrows the IDs passed to `visibleTo`, so the local MCP's "this repo's project" line follows the same rule. A restricted project simply doesn't appear in `/api/projects`.

**Needs work:**

| Where | Problem today | Change |
|---|---|---|
| `publish/routes.ts` `target()` | A new artifact in an existing project checks only `project.create`, for people | Require `project.publish`. Refuse with `conflict`, "That project name is taken", which says no more than a slug clash does and doesn't send anyone hunting for a new artifact slug. |
| `/api/projects`, project page | Built only from visible artifacts, so a grantee with nothing visible yet can't reach the project | Include projects where the caller holds a grant |
| `realtime/events.ts` | Access is checked once at connect, so a stream outlives revocation by up to 5 minutes | Recheck on the 25-second heartbeat and close. Losing a team can now remove many artifacts at once. |
| `DELETE /api/people/:id` | Doesn't know about teams | Delete their `team_members` and person `project_access` rows in the same transaction |
| Share links and outside invites | Any publisher can make one | In a restricted project, they need `manage`. Otherwise a link undoes the restriction. |
| Restricting a project | New action | Confirm first with who loses access and how many share links stay live, with an option to revoke them |
| `/api/activity` | Rows with no artifact are dropped, apart from `purged` for admins | Show the new kinds to admins, with team and project names in the payload |
| `POST /api/invites`, `/join` | Role only | Optional teams on an org invite; a project invite makes an outside account with that grant. Tokens can't use either. |
| `/api/shares` | Links and outside people only | Add project grants held by outside people |

Presigned file URLs still outlive revocation until they expire. That's the existing behaviour, not a new gap.

## Making it easy to use

**One sharing sheet, at both levels.** `ShareSheet` in `apps/viewer/src/components/share.tsx` becomes the same component for projects and artifacts:

```text
Share "Checkout redesign"

Who has access
  ( ) Everyone in Acme        (x) Only people and teams added

[ Add a person, team or email...        ]

Design team            4 people     Can comment  v
Priya Shah             Admin        Can manage        via role
Sam Lee                             Can comment       via Design team
Noor Ali               Reviewer     Can comment       capped by role
```

- One field finds people and teams. An unknown email becomes an outside invite, as it does now.
- Every row says where its access came from. Inherited rows link to their source, and can't be edited here.
- The artifact sheet shows "Everyone in Checkout" for `org`, and the project's own rows as inherited.
- The levels are always the same four words.

**Other surfaces:**

- **Settings › Teams:** list, create, and a team page with members, leads and what's shared with it. It lives under the reserved `settings` path.
- **Project page:** a Share button and a plain label, "Everyone in Acme" or "Restricted". It's a sheet and not `/:project/access`, which would collide with artifact slugs.
- **Projects list:** a team filter at `/projects?team=design`, which needs no new top-level path.
- **Settings › People:** a person's teams and projects, and team choices when inviting.
- **Settings › Organization:** "New projects are visible to", next to the existing artifact default.

**The agent should say who can see the work.** `artifacts publish` and the MCP publish answer print the audience: `Visible to: Design team and 2 people`. Agents publish more than people do, so this is where a wrong default gets caught.

### CLI and MCP

Tokens can't change teams or project access, so these commands are read-only apart from `share`:

```text
artifacts teams
artifacts project access [<project>]
artifacts share --team <slug> [--comment]
```

An agent can share an artifact with a team at `view` or `comment`, marked `via_token`. Only a person can grant a team `publish`. `artifacts_status` gains the audience. Skill references change with this.

Team leads can give their team's access to anyone they add, including `manage` on a project. That's intended: a project manager chose to trust that team, and the Share sheet shows the team as its source.

## Google sign-in

### Setup

- **Storage:** `org.google_client_id` and `org.google_client_secret`, following `org.vapid_private`. They're outside `settings`, so `/api/org` never returns the secret. Not encrypted with `SESSION_SECRET`: 04 promises that rotating it touches only sessions and content tokens.
- **During setup:** `artifacts setup` prints the redirect URIs and asks for the client ID and secret, and Enter skips. They go in `POST /api/setup`, already authorized by `SETUP_TOKEN`.
- **Later:** Settings › Sign-in, for admins in a browser with a recent sign-in. It lists the URIs to paste and has a **Test** button. Google can only be turned on after one successful round trip by that admin.
- **Sign-in page:** `GET /api/meta` gains `google: boolean`, and the viewer shows the button only then.

There's one redirect URI per viewer origin, from `viewerOrigins()` including the home domain, because session cookies are host-only and Google matches exactly with no wildcards. The route is `/api/auth/google/callback`, on viewer origins only. Sign-in starts with a link, not a form, because of CSP `form-action 'self'`.

### Flow

Authorization code with PKCE, plus `state` and `nonce`, single-use and held for 10 minutes in a table like `webauthn_challenges`, with `org_id`. `state` is bound to the browser by a short-lived host-only cookie whose hash is stored on the row. Without that, an attacker could send someone a callback URL and sign them into the attacker's account. The new routes get rate limits in 04. The ID token comes straight from Google's token endpoint, so checking `iss`, `aud`, `exp` and `nonce` needs no JWT dependency.

```text
identities   id, org_id, person_id, provider, subject, email, hosted_domain, created_at, last_used_at
             unique (org_id, provider, subject)
```

Accounts match on `sub`, because Google says `email` can change and isn't unique. `email_verified` must be true for any match by email.

| Situation | Result |
|---|---|
| Known `sub` | Signed in |
| Email matches an existing person | "Sign in once the usual way to connect Google." Linked after that, with a recent sign-in. |
| On an invite link, and the Google email matches the invite | Account created, linked |
| On an invite link, and the email differs | Refused |
| No match | Refused: "Ask an admin for an invite." |

**Email alone never links an existing account.** Nothing proves that a person owns their email (SPEC 7.3). A member could invite `victim@acme.com` as an outside person, accept the link themselves and keep the 30-day session, with or without a password. Linking automatically would hand the real person an account the attacker can still enter. So a link happens only while accepting an invite, or for a person who has just proved they hold the account. Someone with no password or passkey asks an admin for a reset link first.

### Rules that change

- **SPEC:** "Sign-in through outside providers" leaves the non-goals. Sign-in is email with a password or passkey, or optionally Google.
- **Password reset** also deletes the person's identities. A reset is the way back from a takeover (04).
- **Removing a person** deletes them too.
- **Settings › Sign-in** lists the linked account and can remove it, unless it's the last way in.
- **Owner recovery** doesn't change: `SETUP_TOKEN` still issues a reset link.

### Re-authentication

`recentAuth` guards device approval (`artifacts login`), connector consent, org tokens, passkeys, password changes and purge. A Google-only person needs a way through.

Google documents `prompt=none|consent|select_account`. `prompt=login` and `max_age` aren't on its reference page, and `auth_time` needs a console setting, so we can't force a fresh password. The proposal is a round trip with `login_hint=<sub>` and `prompt=select_account`, requiring the same `sub`, bound to the current session ID, which then sets `auth_at`.

That proves a live Google session in this browser, which is weaker than a password. The Reauth sheet offers a passkey first when there is one. Because it's a redirect, the sheet can't retry the action for you: the person returns to the same page and taps again. Device and connect pages keep their state in the URL, so they're fine.

### Known limit

Suspending someone in Google Workspace doesn't reach Artifacts. Their session lasts up to 30 days from last use, and CLI tokens continue. Offboarding still means removing them here. Group sync and SCIM are out of scope.

## Compatibility

- An upgrade changes nothing a person can see: projects stay open, and there are no new rows. The one exception is new `people.search` access for members.
- Migrations only add.
- The existing permission matrix must pass unchanged.
- Google off means no new routes do anything and the sign-in page is unchanged.

## Tests

Add to the generated matrix in `apps/server/test/permissions.test.ts`:

- **Callers:** team member, team lead, project grantee at each level, person outside a restricted project, reviewer with a team `publish` grant, outside person in a team, person whose only comment right is a token-made team row, org token with all projects and with the project named.
- **Dimension:** open or restricted project.

Also:

- A hidden artifact in a restricted project can't reach a search hit, snippet, count, project list, activity row, push or MCP card.
- A direct `view` row beats a team `comment` grant. Project `publish` can't replace someone else's artifact.
- A token-made team grant tied with a person-made project grant still lets the person decide.
- A reviewer with project `manage` can't manage. A CLI token of a project manager can't archive or publish to a teammate's artifact.
- An org token with all projects can publish twice to a restricted project it created.
- Removing someone from a team stops open frames within seconds and closes event streams within a heartbeat.
- Publishing to a restricted project without access gives the same error as a taken slug.
- OAuth, with a fake Google in tests: wrong `state`, reused `state`, `state` from another browser, wrong `nonce`, `email_verified: false`, wrong `aud`, each row of the flow table, reset removing identities, re-auth with a different `sub`.

## Documents to change

`SPEC.md` (§1 goals, non-goals, §7.3), `02-data-model.md`, `03-api.md`, `04-auth-and-permissions.md`, `06-viewer.md`, `07-cli-and-skill.md`, `09-deploy.md`, `11-milestones.md`, `progress.md`, `README.md`, `SECURITY.md`, and the skill.

## Milestones

M17 and M18 depend on each other in that order. M19 is separate and can ship first.

### M17 · Teams

**Build:**
- `teams`, `team_members` and `artifact_team_access`, with `inherited` in both resource loaders and `effective()` in `can.ts`.
- Team routes, `people.search`, Settings › Teams, and teams in the Share sheet with the source of each person's access.
- `artifacts teams`, `share --team`, and teams on org invites.
- Event streams recheck access on the heartbeat.

**Agent checks:** the existing matrix unchanged, new team rows, `via_token` on team grants, removal and revocation.
**User checks:** create a team and share with it from a phone.

### M18 · Project access

**Build:**
- `project_access`, `projects.restricted`, `defaultProjectAccess`, `project.publish` in `target()`, and creators getting `manage`.
- The project Share sheet, the restrict confirmation, project invites and the team filter.
- The rule for links in restricted projects, org token behaviour, and the audience line in `publish` and MCP.

**Agent checks:** the leak tests above, across every caller; open projects matching M17's matrix exactly.
**User checks:** restrict a real project, then confirm from a second account that it's gone from search and from the connector.

### M19 · Google sign-in

**Build:**
- `identities`, the code flow, sign-in and invite buttons, and the linking step.
- Google in `artifacts setup` and Settings › Sign-in, with Test.
- Re-auth through Google, bound to the session. Reset and removal delete identities.

**Agent checks:** a scripted fake Google through every row of the flow table, with the negative cases.
**User checks:** a real Google client on the Railway server, and passkey and Google on the same account on an iPhone.

## Out of scope

Multi-org, deny rules, nested teams, private teams, custom roles, per-page permissions, hiding work from admins, "require Google for everyone", SAML, SCIM, Google Workspace group sync, and an audit log export.

## Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| 1 | Can admins see restricted projects? | Yes. They run the deployment and have the database anyway. |
| 2 | Can outside people join teams? | Yes, capped at `comment`, added only by a person. It's how a contractor or client gets one project. |
| 3 | Can anyone with a Workspace domain join on their own? It would check the `hd` claim, with a chosen role and teams, and change "no open sign-up" in SPEC 7.3. | Build it as an opt-in setting, off by default, Workspace only, never `gmail.com`. |
| 4 | Does a Google round trip count as a recent sign-in? | Yes, with a passkey offered first. The alternative makes Google-only people add a passkey before `artifacts login`. |
| 5 | Can members see the people directory? | Yes, names and emails, members and up only. Pickers don't work without it. |

## Unconfirmed

Check these before M19 ships:

- **App verification.** Whether a client using only `openid`, `email` and `profile` needs Google's verification, and how Internal and External consent screens differ. Google's pages I read didn't settle it.
- **Hosts.** Google requires a TLD on the public suffix list and refuses raw IPs, with an exception for localhost. A LAN address won't work. `*.up.railway.app` and `*.ts.net` should be tested with a real client.
