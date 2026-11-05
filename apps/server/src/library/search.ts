import { SNIPPET_MAX } from "@artifacts/schema";
import { sql } from "drizzle-orm";
import type { Deps } from "../api/deps.ts";
import type { Caller } from "../auth/caller.ts";
import { callerKey } from "../data/store.ts";

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
  // An org token has no person, so its own id keeps one integration from using up everyone's searches.
  const who = callerKey(caller) ?? ("tokenId" in caller ? caller.tokenId : "none");
  deps.limits.hit(`search:${who}`, SEARCHES_PER_MINUTE, 60_000);
}

/** Words of a query, letters and digits only, so nothing in it reaches the tsquery syntax. */
const tokensOf = (q: string) => (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS);

/** Every word must match, and the last is a prefix, because ⌘K searches as you type. */
const tsQuery = (tokens: string[]) =>
  tokens.map((token, i) => `'${token}'${i === tokens.length - 1 ? ":*" : ""}`).join(" & ");

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
  const tokens = tokensOf(q);
  const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const query = tokens.length > 0 ? tsQuery(tokens) : "";
  const vector = (text: unknown) => sql`to_tsvector('english', ${text})`;
  const matches = (text: unknown) => sql`(${vector(text)} @@ q.query)`;
  const rank = (text: unknown) => sql`ts_rank(${vector(text)}, q.query)`;
  const noteText = sql.raw(
    `concat_ws(' ', latest.message, latest.name, (select string_agg(value, ' ') from jsonb_each_text(latest.notes)))`,
  );
  const rows = await deps.db.execute(sql`
    with q as (select to_tsquery('english', ${query}) as query),
    latest as (
      select a.id as artifact_id, a.title, a.slug, a.updated_at, v.id as version_id,
        v.summary, v.tags, v.message, v.name, v.notes
      from artifacts a
      join versions v on v.artifact_id = a.id and v.n = a.latest_version
      where a.id = any(string_to_array(${ids.join(",")}, ',')::uuid[])
    ),
    hits as (
      select artifact_id, 'title' as source, null as page, null as ref, title as text,
        5 + ${rank(sql`title`)} as score
      from latest, q where title ilike ${like} or slug ilike ${like} or ${matches(sql`title`)}
      union all
      select artifact_id, 'tag', null, null, array_to_string(tags, ', '), 4
      from latest where exists (select 1 from unnest(tags) tag where tag ilike ${like})
      union all
      select artifact_id, 'summary', null, null, summary, 3 + ${rank(sql`summary`)}
      from latest, q where summary ilike ${like} or ${matches(sql`summary`)}
      union all
      select latest.artifact_id, 'page', p.page_key, null, p.title, 2 + ${rank(sql`p.title`)}
      from latest join pages p on p.version_id = latest.version_id, q
      where p.title ilike ${like} or ${matches(sql`p.title`)}
      union all
      select latest.artifact_id, 'frame', f.page_key, f.frame_key, f.title, 2 + ${rank(sql`f.title`)}
      from latest join frames f on f.version_id = latest.version_id, q
      where f.title ilike ${like} or ${matches(sql`f.title`)}
      union all
      select latest.artifact_id, 'block', b.page_key, b.block_key, left(b.text, ${MAX_TEXT}),
        1 + ${rank(sql`b.text`)}
      from latest join blocks b on b.version_id = latest.version_id, q
      where ${matches(sql`b.text`)}
      union all
      select latest.artifact_id, 'note', null, null, ${noteText}, 1 + ${rank(noteText)}
      from latest, q where ${matches(noteText)}
      union all
      select t.artifact_id, 'comment', t.page_key, t.n::text, c.body, ${rank(sql`c.body`)}
      from comments c
      join threads t on t.id = c.thread_id
      join latest on latest.artifact_id = t.artifact_id, q
      where ${matches(sql`c.body`)}
    ),
    allowed as (
      select * from hits
      where ${sources ? sql`source = any(string_to_array(${sources.join(",")}, ','))` : sql`true`}
    ),
    best as (
      select *, row_number() over (partition by artifact_id order by score desc, source, page, ref) as r
      from allowed
    )
    select best.artifact_id, best.source, best.page, best.ref, best.text, best.score
    from best join latest on latest.artifact_id = best.artifact_id
    where best.r = 1
    order by best.score desc, latest.updated_at desc, best.artifact_id
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
