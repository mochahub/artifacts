import { MINUTE_MS, SNIPPET_MAX } from "@artifacts/schema";
import { sql } from "drizzle-orm";
import type { Caller } from "../auth/caller.ts";
import { limiterKey } from "../auth/caller.ts";
import { containing } from "../db/index.ts";
import type { Deps } from "../deps.ts";

export const SEARCHES_PER_MINUTE = 60;
const MAX_TOKENS = 12;
/** More than any snippet needs, so one enormous block isn't carried through the query. */
const MAX_TEXT = 20_000;

export type Source = "title" | "summary" | "tag" | "block" | "frame" | "page" | "note" | "comment";
export type Hit = {
  artifactId: string;
  source: Source;
  page: string | null;
  ref: string | null;
  text: string;
  score: number;
};

export function rateLimitSearch(deps: Deps, caller: Caller) {
  deps.limits.hit(`search:${limiterKey(caller) ?? "none"}`, SEARCHES_PER_MINUTE, MINUTE_MS);
}

/** Words of a query, letters and digits only, so nothing in it reaches the tsquery syntax. */
const tokensOf = (q: string) => (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS);

/** The last word is a prefix, because ⌘K searches as you type. */
const tsTerms = (tokens: string[]) =>
  tokens.map((token, i) => `'${token}'${i === tokens.length - 1 ? ":*" : ""}`);

/**
 * The best match per artifact, over each artifact's latest version only. `ids` must already have
 * passed can(): LIMIT and OFFSET apply here, in SQL, so a page is never cut short by a filter after it.
 */
export async function searchHits(
  deps: Deps,
  options: { ids: string[]; q: string; limit: number; offset: number; sources?: readonly Source[] },
): Promise<Hit[]> {
  const { ids, q, limit, offset, sources } = options;
  if (ids.length === 0) return [];
  const phrase = /^"([^"]+)"$/.exec(q)?.[1];
  const terms = tsTerms(tokensOf(q));
  const like = containing(phrase ?? q);
  const query = phrase
    ? sql`phraseto_tsquery('english', ${phrase})`
    : sql`to_tsquery('english', ${terms.join(" | ")})`;
  const queries = phrase ? [query] : terms.map((term) => sql`to_tsquery('english', ${term})`);
  const patterns = (phrase ? [phrase] : tokensOf(q)).map((term) => sql`${containing(term)}`);
  const vector = (text: unknown) => sql`to_tsvector('english', ${text})`;
  const matches = (text: unknown) => sql`(${vector(text)} @@ q.query)`;
  const rank = (text: unknown) => sql`ts_rank(${vector(text)}, q.query)`;
  const matchedVector = (value: unknown) =>
    sql`array(select distinct term::text from unnest(q.terms) term where ${value} @@ term)`;
  // OFFSET prevents inlining: parse the text once, rather than once per query term.
  const matched = (text: unknown, substring = false) =>
    sql`array(select distinct term::text
      from (select ${vector(text)} as vector offset 0) v,
        unnest(q.terms, q.patterns) as t(term, pattern)
      where v.vector @@ term ${substring ? sql`or ${text} ilike pattern` : sql``})`;
  const titleText = sql`concat_ws(' ', title, slug)`;
  const tagText = sql`array_to_string(tags, ', ')`;
  const noteText = sql.raw(
    `concat_ws(' ', latest.message, latest.name, (select string_agg(value, ' ') from jsonb_each_text(latest.notes)))`,
  );
  const rows = await deps.db.execute(sql`
    with q as (select ${query} as query, array[${sql.join(queries, sql`, `)}]::tsquery[] as terms,
      array[${sql.join(patterns, sql`, `)}]::text[] as patterns),
    latest as (
      select a.id as artifact_id, a.title, a.slug, a.updated_at, v.id as version_id,
        v.summary, v.tags, v.message, v.name, v.notes
      from artifacts a
      join versions v on v.artifact_id = a.id and v.n = a.latest_version
      where a.id = any(string_to_array(${ids.join(",")}, ',')::uuid[])
    ),
    -- Keep vectors for long matching text: rank and coverage must not parse it again.
    body_matches as materialized (
      select latest.artifact_id, 'block' as source, b.page_key as page, b.block_key as ref,
        left(b.text, ${MAX_TEXT}) as text, ${vector(sql`b.text`)} as vector, 1 as weight
      from latest join blocks b on b.version_id = latest.version_id, q
      where ${matches(sql`b.text`)}
      union all
      select t.artifact_id, 'comment', t.page_key, t.n::text, c.body, ${vector(sql`c.body`)}, 0
      from comments c
      join threads t on t.id = c.thread_id
      join latest on latest.artifact_id = t.artifact_id, q
      where ${matches(sql`c.body`)}
    ),
    hits as (
      select artifact_id, 'title' as source, null as page, null as ref, title as text,
        5 + ${rank(sql`title`)} as score, ${matched(titleText, true)} as terms
      from latest, q where title ilike ${like} or slug ilike ${like}
        or ${matches(sql`title`)} or ${matches(sql`slug`)}
      union all
      select artifact_id, 'tag', null, null, ${tagText}, 4, ${matched(tagText, true)}
      from latest, q where exists (select 1 from unnest(tags) tag where tag ilike ${like})
        or ${matches(tagText)}
      union all
      select artifact_id, 'summary', null, null, summary, 3 + ${rank(sql`summary`)}, ${matched(sql`summary`, true)}
      from latest, q where summary ilike ${like} or ${matches(sql`summary`)}
      union all
      select latest.artifact_id, 'page', p.page_key, null, p.title,
        2 + ${rank(sql`p.title`)}, ${matched(sql`p.title`, true)}
      from latest join pages p on p.version_id = latest.version_id, q
      where p.title ilike ${like} or ${matches(sql`p.title`)}
      union all
      select latest.artifact_id, 'frame', f.page_key, f.frame_key, f.title,
        2 + ${rank(sql`f.title`)}, ${matched(sql`f.title`, true)}
      from latest join frames f on f.version_id = latest.version_id, q
      where f.title ilike ${like} or ${matches(sql`f.title`)}
      union all
      select artifact_id, source, page, ref, text, weight + ts_rank(vector, q.query),
        ${matchedVector(sql`vector`)}
      from body_matches, q
      union all
      select latest.artifact_id, 'note', null, null, ${noteText}, 1 + ${rank(noteText)}, ${matched(noteText)}
      from latest, q where ${matches(noteText)}
    ),
    allowed as (
      select * from hits
      where ${sources ? sql`source = any(string_to_array(${sources.join(",")}, ','))` : sql`true`}
    ),
    -- A term counts once per artifact, even across fields or repeated mentions.
    coverage as (
      select artifact_id, count(distinct term) as matched
      from allowed cross join lateral unnest(terms) term
      group by artifact_id
    ),
    best as (
      select *, row_number() over (
        partition by artifact_id order by cardinality(terms) desc, score desc, source, page, ref, text
      ) as r
      from allowed
    )
    select best.artifact_id, best.source, best.page, best.ref, best.text, best.score
    from best join latest on latest.artifact_id = best.artifact_id
    left join coverage on coverage.artifact_id = best.artifact_id
    where best.r = 1
    order by coalesce(coverage.matched, 0) desc, best.score desc, latest.updated_at desc, best.artifact_id
    limit ${limit} offset ${offset}
  `);
  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    artifactId: row.artifact_id as string,
    source: row.source as Source,
    page: row.page as string | null,
    ref: row.ref as string | null,
    text: (row.text as string | null) ?? "",
    score: Number(row.score),
  }));
}

/** A short window of plain text around the first word that matches. It holds no markup of any kind. */
export function snippet(text: string, q: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  const lower = flat.toLowerCase();
  const positions = tokensOf(q.toLowerCase()).flatMap((token) => {
    // Stemming matched it, so the word as typed may be a little different: look for its start.
    const found = lower.indexOf(token.slice(0, Math.max(4, token.length - 2)));
    return found < 0 ? [] : [found];
  });
  const at = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 40);
  const cut = flat.slice(start, start + SNIPPET_MAX - 2);
  return `${start > 0 ? "…" : ""}${cut}${start + cut.length < flat.length ? "…" : ""}`;
}
