import { useSignal } from "@preact/signals";
import { Search as SearchIcon } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { Shell } from "../components/shell.tsx";
import { usePoll } from "../poll.ts";
import { SignedIn } from "./guard.tsx";

type Hit = { id: string; project: string; slug: string; title: string };
type Results = {
  artifacts: Hit[];
  pages: (Hit & { pageKey: string; pageTitle: string | null })[];
  comments: (Hit & { thread: number; pageKey: string; body: string; author: string })[];
};

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
  const { data } = usePoll<Results>(
    query.length >= 2 ? `/api/search?q=${encodeURIComponent(query)}` : null,
    3_600_000,
  );
  const results = query.length >= 2 ? data.value : null;
  const row = (href: string, title: string, sub: string, key: string) => (
    <a class="li" href={href} key={key} onClick={onPick}>
      <div class="grow">
        <div class="tt">{title}</div>
        <div class="ss">{sub}</div>
      </div>
    </a>
  );
  const none = results && results.artifacts.length + results.pages.length + results.comments.length === 0;
  return (
    <>
      <label class="search">
        <SearchIcon />
        <input
          ref={field}
          placeholder="Search artifacts, pages and comments"
          aria-label="Search"
          value={q.value}
          onInput={(event) => {
            q.value = event.currentTarget.value;
          }}
        />
      </label>
      {none && <div class="empty">Nothing found.</div>}
      {results && results.artifacts.length > 0 && (
        <>
          <span class="gh">Artifacts</span>
          <div class="group">
            {results.artifacts.map((hit) =>
              row(`/${hit.project}/${hit.slug}`, hit.title, hit.project, hit.id),
            )}
          </div>
        </>
      )}
      {results && results.pages.length > 0 && (
        <>
          <span class="gh">Pages</span>
          <div class="group">
            {results.pages.map((hit) =>
              row(
                `/${hit.project}/${hit.slug}/${hit.pageKey}`,
                hit.pageTitle ?? hit.pageKey,
                hit.title,
                `${hit.id}/${hit.pageKey}`,
              ),
            )}
          </div>
        </>
      )}
      {results && results.comments.length > 0 && (
        <>
          <span class="gh">Comments</span>
          <div class="group">
            {results.comments.map((hit) =>
              row(
                `/${hit.project}/${hit.slug}/${hit.pageKey}?c=${hit.thread}`,
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

export function SearchPage() {
  return (
    <SignedIn>
      <Shell>
        <h1 class="h1 l">Search</h1>
        <SearchBox />
      </Shell>
    </SignedIn>
  );
}
