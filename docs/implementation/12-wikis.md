# Wikis

**Contract** for Phase 1 of the company brain: wikis that agents write and people read and comment on. The behaviour is in [SPEC.md §16](../SPEC.md#16-wikis). The plan behind it is the hosted artifact `artifacts/company-brain`. This document owns the names and shapes below. Editing in the browser is Phase 2, and isn't here.

## Concepts

- **A wiki** is a project whose `kind` is `wiki`. Its artifacts are the wiki's pages.
- **The company brain** is a wiki open to the organization. **A personal wiki** is a restricted wiki: only the person who made it holds a grant (`manage`), and admins see it as they see every project.
- **Roles.** Each artifact in a wiki is a `page` (the default) or a `source`. A source is what came in: a document, a transcript or a web clip. Sources are only ever republished, never edited into pages.
- **The rules page** is the artifact with the slug `rules` (`WIKI_RULES_SLUG`). It tells agents how this wiki is organized. Agents read it before they write anything.
- **The index and the log** aren't pages. The server derives them: the index from the wiki's artifacts, and the log from `activity`.

## Authoring

### The manifest's `wiki` field

`WikiMeta` in `packages/schema/src/manifest.ts`:

```jsonc
{
  "wiki": {
    "role": "page",                    // or "source"; defaults to "page"
    "sources": ["q3-board-notes"],     // slugs of sources in the same wiki, up to 50
    "origin": "https://example.com/a", // a source's address, http or https
    "untrusted": true                  // a source from the open web, a guest or anyone outside
  }
}
```

The CLI sends it as `wiki` in the commit body, and the MCP article tool accepts the same fields. The server stores it in `versions.wiki`. It means nothing outside a wiki.

Publishing to a wiki refuses a `sources` entry unless it names an existing source in that wiki that the publisher can read. A role `page` target is refused; link to pages in the article body instead. An artifact cannot cite its own slug, even if its role is `source`. These checks run in the shared publisher for CLI/API and MCP commits. Missing and unreadable targets produce the same error. MCP metadata errors name each invalid field and its validation reason.

Both wiki read views retain the declared citation slugs, including old broken citations and citations whose targets are no longer visible. The links view resolves unavailable targets with `exists: false` and no private metadata. The garden reports these citations as `wanted`, with the citing pages in `refs`; an `unsourced` finding for such a page explains that none of its citations resolve to a source.

### Wiki links

In an article, `[[Target]]`, `[[Target|label]]` and `[[other-wiki/Target]]` become links to `/<wiki>/<slug>`. Here `<wiki>` is the article's own project unless the link names another, and `<slug>` is `wikiSlug(Target)`: lowercase ASCII, with runs of anything else made into `-`, capped at 40 characters. So `[[Pricing & Plans]]` links to `/<wiki>/pricing-plans`.

- `buildArticle` does this when it's given `project`. The CLI passes the manifest's `project`, and the MCP tool passes its `project` argument. Without a project, wiki links stay as text.
- Code spans and existing links are left alone.
- Ordinary Markdown links to `/<project>/<slug>` count as links too.

### Links at commit

At commit, the server runs `articleLinks()` (`packages/schema/src/wiki.ts`) over the HTML it has just sanitized. It stores every `project/slug` that the version's articles link to in `versions.links` (a `text[]` with a GIN index), leaving out the artifact itself. What a client sends is never trusted for this. A restore copies `wiki` and `links` with everything else.

## HTTP API

Shapes are in `packages/schema/src/api.ts` under "Wikis".

### `POST /api/wikis`

Body `CreateWiki` `{ slug, name, personal }`. Guard `{ action: "project.create" }`. Answers `WikiCreated` `{ slug, name, personal, url }`: 201 when it makes the wiki, and 200 when the wiki already exists.

| The slug | What happens |
|---|---|
| Free | Insert `projects` with `kind: "wiki"` and `restricted: personal`. A person caller gets a `manage` grant, as the first publish gives one. `personal` from an organization token is `invalid`: a token has no person to keep it private to |
| A wiki the caller sees | Nothing changes. Answers 200 with its current values |
| An ordinary project the caller manages (admin, or a `manage` grant) | Becomes a wiki and keeps its access. Answers 200 |
| Anything else, including a restricted project the caller can't see | `conflict`, "That name is taken." |

### `GET /api/wikis/:slug`

Guard `{ action: "project.read", resource: projectParam }`. A project that isn't a wiki is `not_found`. Answers `WikiSpace`:

- `project`:
  - `personal` is `restricted`;
  - `canPublish` is `can(caller, "project.publish", project)`;
  - `canShare` is `can(caller, "project.access.read", project)`.
- `rules`, `pages` and `sources`:
  - Built from the wiki's artifacts that the caller can see (`visibleTo`), leaving out archived ones.
  - Each one is a `WikiPage`, made from its latest version.
  - `rules` is the artifact whose slug is `rules`, or null.
  - `pages` holds role `page` (without `rules`), sorted by title. `sources` holds role `source`, newest first.
- `WikiPage` fields:
  - `role` is `wiki.role`, or `page` when absent.
  - `untrusted` is true for a source marked untrusted, or a page that cites one.
  - `backlinks` counts distinct visible artifacts, in any project, whose latest version links to this one.
  - `open` counts open threads.
- `log`: the last 50 `activity` rows for the project, newest first. `by` is the actor's name, or "Guest". `version` and `message` come from the payload when it has them.
- `garden`: findings, in this order:

| `kind` | When | `slug` | `refs` |
|---|---|---|---|
| `untrusted` | A page cites an untrusted source | the page | those sources |
| `stale` | A source a page cites was published after the page's latest version | the page | those sources |
| `wanted` | Pages here link to or cite `<wiki>/<x>`, and the target is unavailable | `x` | the linking or citing pages |
| `orphan` | A page (not `rules`) that nothing visible links to | the page | none |
| `unsourced` | A page (not `rules`) citing no sources, in a wiki that has at least one source | the page | none |

`message` is one plain sentence for a person.

### `GET /api/artifacts/:id/links`

Guard `{ action: "artifact.read", resource: artifactParam }`. Answers `ArtifactLinks`:

- `wiki`: whether the artifact's project is a wiki.
- `role`, `untrusted` and `origin`: from its latest version, as in `WikiPage`.
- `outgoing`: one `WikiLink` per entry in its latest version's `links`, in order. A target the caller can't see looks exactly like one that doesn't exist: `exists: false` and `title: null`.
- `backlinks`: visible artifacts, in any project, whose latest version links to this one. Newest first, at most 100.
- `sources`: its `wiki.sources`, resolved in its own project.

## Hosted MCP tools

These are in `apps/server/src/mcp/routes.ts`, and their specs are in `packages/schema/src/mcp.ts`. Every result that carries text people wrote is `untrusted`.

| Tool | Scope | Input | Answer |
|---|---|---|---|
| `artifacts_wiki` | read | `wiki?` | Without `wiki`: the wikis the caller sees, as `{ slug, name, personal, pages, sources }`. With `wiki`: the `WikiSpace`, with the log cut to 20 entries, plus `rulesText`, the first chunk of the rules page as `artifacts_read` returns it (null if there's no rules page) |
| `artifacts_wiki_links` | read | `artifact` (`project/slug`) | `ArtifactLinks` |
| `artifacts_wiki_create` | publish | `slug`, `name`, `personal?` | `WikiCreated` |
| `artifacts_comment` | comment | `artifact`, `message`, `page?` | Opens a page-level thread (no anchor) on the latest version, as agent "Connector", and answers `{ id }` with the thread's number. For findings from a garden pass |
| `artifacts_publish_article` | publish | Adds `role?`, `sources?`, `origin?`, `untrusted?` | As before. The fields are checked with `WikiMeta`, written to the manifest's `wiki` and the commit's `wiki`, and wiki links resolve against `project` |

The list's `pages` count excludes `rules`, matching `WikiSpace.pages`; `sources` counts `WikiSpace.sources`.

The server instructions add one sentence: in a wiki, call `artifacts_wiki` first and follow its rules page.

## CLI

- `artifacts publish` and `artifacts pack` pass `project` to `buildArticle`, and `wiki` (from the manifest) in the commit body.
- `artifacts wiki create <slug> [--name <name>] [--personal]` calls `POST /api/wikis`.
- `artifacts wiki show <slug> [--json]` prints the rules page's summary, the pages, the sources and the findings. Empty Pages, Sources and Garden sections say `none`.
- `artifacts wiki links <project/slug> [--json]` prints the artifact's role, untrusted mark and origin, then the links, backlinks and sources with origins when present. Empty sections say `none`.
- The skill's `references/wiki.md` holds the agent's workflows: ingest, ask, garden, and a starter rules page. The hosted MCP serves it as `artifacts://guides/wiki`.

## Viewer

- **A wiki's home.** `/:project`, when the project is a wiki, shows the wiki instead of the artifact grid. It has the rules page, the pages and sources (each with its summary), what needs attention (the garden findings), and recent changes (the log). It loads lazily, outside the 80 KB budget.
- **A page.** `/:project/:slug`, for an artifact in a wiki with exactly one page, replaces itself with that page's route.
- **An article in a wiki** ends with its sources (untrusted ones marked, with their origin) and "Linked from" (its backlinks). Links in the body to pages that don't exist yet are drawn as wanted: a dashed underline, titled "Not written yet".
- **Projects list.** A wiki is labelled as a wiki, or as a personal wiki.
