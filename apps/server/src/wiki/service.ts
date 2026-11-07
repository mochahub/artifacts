import type {
  ArtifactLinks,
  CreateWiki,
  WikiFinding,
  WikiLink,
  WikiMeta,
  WikiPage,
  WikiSpace,
} from "@artifacts/schema";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { type LoadedArtifact, type LoadedProject, toProject } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { can, seesProject } from "../auth/can.ts";
import {
  activity,
  artifacts,
  org,
  people,
  projectAccess,
  projects,
  teams,
  threads,
  tokens,
  versions,
} from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { requireCan } from "../http/routes.ts";
import { visibleTo } from "../library/visible.ts";

export async function createWiki(
  deps: Deps,
  orgId: string,
  caller: Caller,
  body: z.infer<typeof CreateWiki>,
) {
  requireCan(caller, "project.create", { type: "org" });
  const [existing] = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.slug, body.slug)));
  const onlyMe = body.onlyMe || body.personal;
  let team: typeof teams.$inferSelect | undefined;
  if (!existing) {
    if ((onlyMe || body.team) && caller.kind === "orgToken")
      throw new ApiError("invalid", "A restricted starting audience needs a person to own it.");
    [team] = body.team
      ? await deps.db
          .select()
          .from(teams)
          .where(and(eq(teams.orgId, orgId), eq(teams.slug, body.team)))
      : [];
    if (body.team && (!team || !can(caller, "team.read", { type: "team", id: team.id, leadIds: [] })))
      throw new ApiError("invalid", "Choose a team you can see. Run artifacts teams to list them.");
  }
  const made = existing
    ? undefined
    : await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(projects)
          .values({
            id: Bun.randomUUIDv7(),
            orgId,
            slug: body.slug,
            name: body.name,
            kind: "wiki",
            restricted: !!(onlyMe || body.team),
            createdBy: caller.kind === "orgToken" ? null : caller.person.id,
            createdByToken: caller.kind === "orgToken" ? caller.tokenId : null,
          })
          .onConflictDoNothing()
          .returning();
        if (row && caller.kind !== "orgToken")
          await tx.insert(projectAccess).values({
            id: Bun.randomUUIDv7(),
            orgId,
            projectId: row.id,
            personId: caller.person.id,
            permission: "manage",
            grantedBy: caller.person.id,
            createdAt: deps.clock.now(),
          });
        if (row && team && caller.kind !== "orgToken")
          await tx.insert(projectAccess).values({
            id: Bun.randomUUIDv7(),
            orgId,
            projectId: row.id,
            teamId: team.id,
            permission: "publish",
            grantedBy: caller.person.id,
            createdAt: deps.clock.now(),
          });
        return row;
      });
  let row = made;
  if (!row) {
    [row] = await deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, body.slug)));
    if (!row) throw new ApiError("conflict", "That name is taken.");
    const place = await toProject(deps, row);
    const manages =
      (caller.kind === "person" || caller.kind === "cliToken") &&
      (["owner", "admin"].includes(caller.person.role) ||
        place.grants.some((g) => g.personId === caller.person.id && g.level === "manage"));
    if (!seesProject(caller, place) || (row.kind !== "wiki" && !manages))
      throw new ApiError("conflict", "That name is taken.");
    // An existing audience is never narrowed or widened here, so refuse a narrower request out loud.
    const actual = await wikiAudience(deps, caller, place);
    const asked = onlyMe ? "me" : body.team ? "team" : "org";
    if (AUDIENCE_RANK[asked] < AUDIENCE_RANK[actual.audience.kind])
      throw new ApiError(
        "conflict",
        `${row.slug} already exists with audience "${actual.audience.label.replace(/\.$/, "")}". ` +
          `You asked for ${asked === "me" ? "only you" : "a team"}. The audience was not changed; ` +
          "change who can read it in the viewer's Share sheet.",
      );
    if (row.kind !== "wiki")
      await deps.db.update(projects).set({ kind: "wiki" }).where(eq(projects.id, row.id));
  }
  return {
    created: !!made,
    body: {
      slug: row.slug,
      name: row.name,
      ...(await wikiAudience(deps, caller, await toProject(deps, row))),
      url: `${deps.env.publicUrl}/${row.slug}`,
      created: !!made,
    },
  };
}

/** Said only to a caller who can read the project, so it reveals nothing. */
export const notWiki = (slug: string) =>
  `${slug} isn't a wiki. Make it one with artifacts wiki create ${slug}.`;

const AUDIENCE_RANK = { me: 0, team: 1, org: 2 } as const;

/** Audience uses actual grants; directory visibility controls which team names leave the server. */
export async function wikiAudience(deps: Deps, caller: Caller, place: LoadedProject) {
  const grants = await deps.db
    .select({ team: teams })
    .from(projectAccess)
    .leftJoin(teams, eq(teams.id, projectAccess.teamId))
    .where(eq(projectAccess.projectId, place.id));
  const [readerToken] = await deps.db
    .select({ id: tokens.id })
    .from(tokens)
    .where(
      and(
        eq(tokens.orgId, place.row.orgId),
        eq(tokens.kind, "org"),
        sql`${place.id} = any(${tokens.projectIds})`,
        sql`'read' = any(${tokens.scopes})`,
        isNull(tokens.revokedAt),
        or(isNull(tokens.expiresAt), gt(tokens.expiresAt, deps.clock.now())),
      ),
    )
    .limit(1);
  const [home] = await deps.db.select({ name: org.name }).from(org).where(eq(org.id, place.row.orgId));
  const shared =
    !!readerToken ||
    grants.some((g) => g.team) ||
    place.grants.some((g) => g.personId !== place.row.createdBy);
  const visibleTeams = grants.flatMap((g) =>
    g.team && can(caller, "team.read", { type: "team", id: g.team.id, leadIds: [] })
      ? [{ slug: g.team.slug, name: g.team.name }]
      : [],
  );
  const kind = !place.restricted ? ("org" as const) : shared ? ("team" as const) : ("me" as const);
  const isSelf = caller.kind !== "orgToken" && "person" in caller && caller.person.id === place.row.createdBy;
  const direct = kind === "me" && isSelf;
  return {
    // Older released CLIs require this boolean when parsing wiki responses.
    personal: kind === "me",
    audience: {
      kind,
      label:
        kind === "org"
          ? `Everyone in ${home?.name ?? "the organization"}`
          : kind === "me"
            ? isSelf
              ? "Only you"
              : "Only the owner"
            : visibleTeams.length
              ? visibleTeams.map((t) => `${t.name} team`).join(", ")
              : "Shared wiki",
      ...(visibleTeams.length ? { teams: visibleTeams } : {}),
    },
    guidance: {
      edits: direct ? ("direct" as const) : ("suggestion" as const),
      text: guidanceText(kind, isSelf, visibleTeams, home?.name),
    },
  };
}

function guidanceText(
  kind: "me" | "team" | "org",
  isSelf: boolean,
  teams: { name: string }[],
  orgName = "the organization",
) {
  if (kind === "me")
    return isSelf
      ? "Only you can read this wiki: edit directly."
      : "Only the owner can read this wiki: propose suggestions rather than editing directly.";
  const readers =
    kind === "org"
      ? `Everyone in ${orgName} can read this wiki`
      : teams.length
        ? `${teams.map((t) => `${t.name} team`).join(", ")} can read this wiki`
        : "Others can read this wiki";
  return `${readers}: propose suggestions rather than editing directly.`;
}

// One latest-version join for the visible library keeps every derived count and reference private.
async function library(deps: Deps, orgId: string, caller: Caller, projectId?: string) {
  const visible = await visibleTo(deps, orgId, caller, { projectId });
  if (!visible.length) return [];
  // Only the columns a wiki reads: `files` alone can be large, and this runs over the whole library.
  const latest = await deps.db
    .select({
      artifactId: artifacts.id,
      version: {
        n: versions.n,
        summary: versions.summary,
        tags: versions.tags,
        wiki: versions.wiki,
        links: versions.links,
        agent: versions.agent,
        publishedAt: versions.publishedAt,
      },
      by: people.name,
    })
    .from(artifacts)
    .innerJoin(versions, and(eq(versions.artifactId, artifacts.id), eq(versions.n, artifacts.latestVersion)))
    .innerJoin(people, eq(people.id, versions.publishedBy))
    .where(
      inArray(
        artifacts.id,
        visible.map((a) => a.id),
      ),
    );
  const byId = new Map(visible.map((a) => [a.id, a]));
  return latest.flatMap((v) => {
    const a = byId.get(v.artifactId);
    return a
      ? [
          {
            ...a,
            ...v,
            version: { ...v.version, wiki: a.project.kind === "wiki" ? v.version.wiki : null },
            key: `${a.project.slug}/${a.row.slug}`,
          },
        ]
      : [];
  });
}
type Entry = Awaited<ReturnType<typeof library>>[number];

/** A citation must name a readable source in this wiki; hidden and missing targets look the same. */
export async function validateWikiSources(
  deps: Deps,
  orgId: string,
  caller: Caller,
  projectId: string,
  slug: string,
  wiki: WikiMeta,
) {
  if (!wiki.sources.length) return;
  if (wiki.sources.includes(slug))
    throw new ApiError("invalid", `wiki.sources: an artifact cannot cite itself ("${slug}").`);
  const all = await library(deps, orgId, caller, projectId);
  for (const source of wiki.sources) {
    const target = all.find((a) => a.row.slug === source);
    if (!target)
      throw new ApiError(
        "invalid",
        `wiki.sources: "${source}" must name an existing source you can read in this wiki.`,
      );
    if (target.version.wiki?.role !== "source")
      throw new ApiError("invalid", `wiki.sources: "${source}" has role page; cite a source.`);
  }
}

const cited = (a: Entry, all: Entry[]) =>
  all.filter(
    (s) =>
      s.project.id === a.project.id &&
      s.version.wiki?.role === "source" &&
      a.version.wiki?.sources.includes(s.row.slug),
  );
const untrusted = (a: Entry, all: Entry[]) =>
  a.version.wiki?.role === "source"
    ? a.version.wiki.untrusted === true
    : cited(a, all).some((s) => s.version.wiki?.untrusted);
const link = (key: string, all: Entry[]): WikiLink => {
  const [project = "", slug = ""] = key.split("/");
  const a = all.find((a) => a.key === key);
  return {
    project,
    slug,
    exists: !!a,
    title: a?.row.title ?? null,
    summary: a?.version.summary ?? null,
    untrusted: a ? untrusted(a, all) : false,
    origin: a?.version.wiki?.origin ?? null,
  };
};
async function incoming(deps: Deps, keys: string[], all: Entry[]) {
  if (!keys.length || !all.length) return [];
  return deps.db
    .select({ id: artifacts.id, links: versions.links })
    .from(artifacts)
    .innerJoin(versions, and(eq(versions.artifactId, artifacts.id), eq(versions.n, artifacts.latestVersion)))
    .where(
      and(
        inArray(
          artifacts.id,
          all.map((a) => a.id),
        ),
        sql`${versions.links} && ARRAY[${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )}]::text[]`,
      ),
    );
}
export async function artifactLinks(
  deps: Deps,
  orgId: string,
  caller: Caller,
  artifact: LoadedArtifact,
): Promise<ArtifactLinks> {
  const all = await library(deps, orgId, caller);
  const a = all.find((a) => a.id === artifact.id);
  if (!a) throw new ApiError("not_found", "Not found.");
  const back = new Set((await incoming(deps, [a.key], all)).map((b) => b.id));
  return {
    wiki: a.project.kind === "wiki",
    role: a.version.wiki?.role ?? "page",
    origin: a.version.wiki?.origin ?? null,
    untrusted: untrusted(a, all),
    outgoing: a.version.links.map((k) => link(k, all)),
    backlinks: all
      .filter((b) => back.has(b.id))
      .sort((a, b) => b.version.publishedAt.getTime() - a.version.publishedAt.getTime())
      .slice(0, 100)
      .map((b) => link(b.key, all)),
    sources: (a.version.wiki?.sources ?? []).map((s) => link(`${a.project.slug}/${s}`, all)),
  };
}
export async function wikiSpace(
  deps: Deps,
  orgId: string,
  caller: Caller,
  place: LoadedProject,
): Promise<WikiSpace> {
  requireCan(caller, "project.read", place);
  if (place.row.kind !== "wiki") throw new ApiError("not_found", notWiki(place.row.slug));
  const all = await library(deps, orgId, caller);
  const visibleProject = all.filter((a) => a.project.id === place.id);
  const own = visibleProject.filter((a) => !a.row.archivedAt);
  const [back, open, log] = await Promise.all([
    incoming(
      deps,
      own.map((a) => a.key),
      all,
    ),
    own.length
      ? deps.db
          .select()
          .from(threads)
          .where(
            and(
              inArray(
                threads.artifactId,
                own.map((a) => a.id),
              ),
              eq(threads.status, "open"),
            ),
          )
      : [],
    deps.db
      .select({ event: activity, by: people.name })
      .from(activity)
      .leftJoin(people, eq(people.id, activity.actorPersonId))
      .where(
        or(
          eq(activity.projectId, place.id),
          ...(visibleProject.length
            ? [
                inArray(
                  activity.artifactId,
                  visibleProject.map((a) => a.id),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(activity.createdAt))
      // Hidden artifacts' rows are dropped after this, so read past the 50 that are shown.
      .limit(500),
  ]);
  const page = (a: Entry): WikiPage => ({
    slug: a.row.slug,
    title: a.row.title,
    summary: a.version.summary,
    tags: a.version.tags ?? [],
    role: a.version.wiki?.role ?? "page",
    untrusted: untrusted(a, all),
    sources: a.version.wiki?.sources ?? [],
    origin: a.version.wiki?.origin ?? null,
    version: a.version.n,
    updatedAt: a.version.publishedAt.toISOString(),
    publishedBy: a.by,
    agent: a.version.agent,
    backlinks: back.filter((b) => b.links.includes(a.key)).length,
    open: open.filter((t) => t.artifactId === a.id).length,
  });
  const pages = own.filter((a) => a.version.wiki?.role !== "source");
  const sources = own.filter((a) => a.version.wiki?.role === "source");
  const garden: WikiFinding[] = [];
  for (const kind of ["untrusted", "stale"] as const)
    for (const a of pages) {
      const refs = cited(a, all)
        .filter((s) =>
          kind === "untrusted" ? s.version.wiki?.untrusted : s.version.publishedAt > a.version.publishedAt,
        )
        .map((s) => s.row.slug);
      if (refs.length)
        garden.push({
          kind,
          slug: a.row.slug,
          refs,
          message:
            kind === "untrusted"
              ? "This page cites an untrusted source."
              : "A source has changed since this page was published.",
        });
    }
  const wanted = new Map<string, string[]>();
  for (const a of pages)
    for (const key of a.version.links)
      if (key.startsWith(`${place.row.slug}/`) && !own.some((b) => b.key === key)) {
        const slug = key.slice(place.row.slug.length + 1);
        wanted.set(slug, [...(wanted.get(slug) ?? []), a.row.slug]);
      }
  const missingSources = new Set<string>();
  for (const a of pages)
    for (const slug of a.version.wiki?.sources ?? [])
      if (!all.some((b) => b.project.id === place.id && b.row.slug === slug)) {
        missingSources.add(slug);
        wanted.set(slug, [...new Set([...(wanted.get(slug) ?? []), a.row.slug])]);
      }
  for (const [slug, refs] of wanted)
    garden.push({
      kind: "wanted",
      slug,
      refs,
      message: missingSources.has(slug)
        ? "A cited source is missing or unavailable."
        : "This page has not been written yet.",
    });
  for (const kind of ["orphan", "unsourced"] as const)
    for (const a of pages.filter((a) => a.row.slug !== "rules"))
      if (
        kind === "orphan"
          ? !back.some((b) => b.links.includes(a.key))
          : sources.length > 0 && !cited(a, all).length
      )
        garden.push({
          kind,
          slug: a.row.slug,
          refs: [],
          message:
            kind === "orphan"
              ? "No pages link to this page."
              : a.version.wiki?.sources.length
                ? "None of this page's citations resolve to a source."
                : "This page cites no sources.",
        });
  const rules = own.find((a) => a.row.slug === "rules");
  return {
    project: {
      slug: place.row.slug,
      name: place.row.name,
      ...(await wikiAudience(deps, caller, place)),
      canPublish: can(caller, "project.publish", place),
      canShare: can(caller, "project.access.read", place),
    },
    rules: rules ? page(rules) : null,
    pages: pages
      .filter((a) => a.row.slug !== "rules")
      .map(page)
      .sort((a, b) => a.title.localeCompare(b.title)),
    sources: sources
      .sort((a, b) => b.version.publishedAt.getTime() - a.version.publishedAt.getTime())
      .map(page),
    garden,
    log: log
      .filter(({ event }) => !event.artifactId || visibleProject.some((a) => a.id === event.artifactId))
      .slice(0, 50)
      .map(({ event, by }) => {
        const a = visibleProject.find((a) => a.id === event.artifactId);
        return {
          at: event.createdAt.toISOString(),
          kind: event.kind,
          slug: a?.row.slug ?? null,
          title: a?.row.title ?? null,
          by: by ?? "Guest",
          agent: event.agent,
          version: typeof event.payload.version === "number" ? event.payload.version : null,
          message: typeof event.payload.message === "string" ? event.payload.message : null,
        };
      }),
  };
}
