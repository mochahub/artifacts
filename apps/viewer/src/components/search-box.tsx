import { useSignal } from "@preact/signals";
import { Search as SearchIcon } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { artifactHref, frameHref, threadHref } from "../paths.ts";
import { usePoll } from "../poll.ts";
import { Loaded } from "./loaded.tsx";
import { PlaceholderRows } from "./placeholder.tsx";

type Hit = { id: string; project: string; slug: string; title: string };
type Results = {
  artifacts: Hit[];
  pages: (Hit & { pageKey: string; pageTitle: string | null })[];
  comments: (Hit & { thread: number; pageKey: string; body: string; author: string })[];
  content?: (Hit & { source: string; pageKey: string | null; ref: string | null; snippet: string })[];
};

type ContentHit = NonNullable<Results["content"]>[number];

/** A frame opens at that frame; anything else opens its page, or the artifact. */
const contentLink = (hit: ContentHit) =>
  hit.source === "frame" && hit.ref ? frameHref(hit, hit.pageKey, hit.ref) : artifactHref(hit, hit.pageKey);

/** The results list, shared by the Search tab and ⌘K. */
export function SearchBox({ onPick }: { onPick?(): void }) {
  const q = useSignal("");
  const settled = useSignal("");
  // A pause, not every key: each search reads everything this person can see.
  useEffect(() => {
    const timer = setTimeout(() => {
      settled.value = q.value;
    }, 200);
    return () => clearTimeout(timer);
  }, [q.value]);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const query = settled.value.trim();
  const poll = usePoll<Results>(
    query.length >= 2 ? `/api/search?q=${encodeURIComponent(query)}` : null,
    3_600_000,
  );
  const row = (href: string, title: string, sub: string, key: string) => (
    <a class="li" href={href} key={key} onClick={onPick}>
      <div class="grow">
        <div class="tt">{title}</div>
        <div class="ss">{sub}</div>
      </div>
    </a>
  );
  return (
    <>
      <label class="search">
        <SearchIcon />
        <input
          ref={field}
          placeholder="Search artifacts, their text and comments"
          aria-label="Search"
          value={q.value}
          onInput={(event) => {
            q.value = event.currentTarget.value;
          }}
        />
      </label>
      {query.length >= 2 && (
        // A first search shows its shape; a retyped one keeps the last results until the next arrive.
        <Loaded from={[poll]} value={poll.data.value} placeholder={<PlaceholderRows rows={3} />}>
          {(results) => <Hits results={results} loading={poll.loading} row={row} />}
        </Loaded>
      )}
    </>
  );
}

function Hits({
  results,
  loading,
  row,
}: {
  results: Results;
  loading: boolean;
  row(href: string, title: string, sub: string, key: string): preact.JSX.Element;
}) {
  const content = results.content ?? [];
  const none =
    !loading &&
    results.artifacts.length + results.pages.length + results.comments.length + content.length === 0;
  return (
    <>
      {none && <div class="empty">Nothing found.</div>}
      {results.artifacts.length > 0 && (
        <>
          <span class="gh">Artifacts</span>
          <div class="group">
            {results.artifacts.map((hit) => row(artifactHref(hit), hit.title, hit.project, hit.id))}
          </div>
        </>
      )}
      {results.pages.length > 0 && (
        <>
          <span class="gh">Pages</span>
          <div class="group">
            {results.pages.map((hit) =>
              row(
                artifactHref(hit, hit.pageKey),
                hit.pageTitle ?? hit.pageKey,
                hit.title,
                `${hit.id}/${hit.pageKey}`,
              ),
            )}
          </div>
        </>
      )}
      {content.length > 0 && (
        <>
          <span class="gh">In the text</span>
          <div class="group">
            {content.map((hit) =>
              row(
                contentLink(hit),
                hit.snippet,
                hit.title,
                `${hit.id}/${hit.pageKey}/${hit.ref}/${hit.source}`,
              ),
            )}
          </div>
        </>
      )}
      {results.comments.length > 0 && (
        <>
          <span class="gh">Comments</span>
          <div class="group">
            {results.comments.map((hit) =>
              row(
                threadHref(hit, hit.pageKey, hit.thread),
                hit.body,
                `${hit.author} on ${hit.title}`,
                `${hit.id}/${hit.thread}/${hit.body}`,
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}
