import type { Artifact, ArtifactLinks, Thread, VersionPageOf } from "@artifacts/schema";
import { articleStyle } from "@artifacts/schema/theme-css";
import { useSignal } from "@preact/signals";
import { Diff, List, MessageCircle, MessagesSquare, ShieldAlert } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { api, post } from "../api.ts";
import { LoadFailed } from "../components/placeholder.tsx";
import { Sheet } from "../components/sheet.tsx";
import { PageCapsule } from "../components/shell.tsx";
import { capitalize, plural } from "../format.ts";
import { articleUrl, artifactHref, renderUrl } from "../paths.ts";
import type { Remote } from "../poll.ts";
import { useReview } from "../review/use-review.tsx";
import { readStored, writeStored } from "../storage.ts";
import { firstChange, markChanges } from "./diff.ts";
import { useLiquidChrome, usePool } from "./liquid.ts";
import { decorate, quoteFromSelection } from "./marks.ts";

export type ArticlePage = VersionPageOf<"article">;

type Props = {
  artifact: Artifact;
  page: ArticlePage;
  version: number;
  /** The version this one is compared with, if any. */
  previous: number | null;
  latest: boolean;
  threads: Remote<Thread[]>;
  onPages(): void;
  onVersions(): void;
};

const SIZES = [17, 19, 21];
const stored = (key: string, fallback: string) => readStored(`artifacts.read.${key}`) ?? fallback;

/** "example.com" for a source's address: the whole URL is too long for one line on a phone. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ArticleView({
  artifact,
  page,
  version,
  previous,
  latest,
  threads,
  onPages,
  onVersions,
}: Props) {
  const links = useSignal<ArtifactLinks | null>(null);
  const linksFailed = useSignal(false);
  useEffect(() => {
    let live = true;
    links.value = null;
    linksFailed.value = false;
    if (artifact.projectKind === "wiki")
      api<ArtifactLinks>(`/api/artifacts/${artifact.id}/links`).then(
        (value) => {
          if (live) links.value = value;
        },
        () => {
          if (live) linksFailed.value = true;
        },
      );
    return () => {
      live = false;
    };
  }, [artifact.id, artifact.projectKind, version]);
  const body = useRef<HTMLDivElement>(null);
  const capsule = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const pool = useRef<HTMLElement>(null);
  const contents = useSignal(false);
  const settings = useSignal(false);
  const changes = useSignal(false);
  const size = useSignal(Number(stored("size", "19")));
  // "theme" until the reader picks: an artifact's own font, and a choice of theirs that isn't stored.
  const font = useSignal(stored("font", page.theme?.font ? "theme" : "serif"));
  const theme = useSignal(stored("theme", "auto"));
  // Places changed since `previous`, once both versions are in; "new" when the page wasn't in it.
  const changed = useSignal<number | "new" | null>(null);
  const loaded = useSignal(0);
  const failed = useSignal(false);
  const attempt = useSignal(0);
  useLiquidChrome({ capsule, bar, body, loaded: loaded.value });
  const picking = useSignal(false);
  usePool(bar, pool, [changes.value, picking.value]);
  const review = useReview({
    artifact,
    page: page.key,
    version,
    threads,
    where: () => page.title ?? page.key,
  });
  const { all, draft, openId, listOpen } = review;
  const selection = useSignal<{ draft: NonNullable<typeof draft.value>; x: number; y: number } | null>(null);
  const pick = (event: MouseEvent) => {
    if (!picking.value) return;
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-block]");
    const key = block?.dataset.block;
    if (!key) return;
    picking.value = false;
    draft.value = { pageKey: page.key, anchor: { type: "block", blockKey: key }, where: where(key) };
  };
  const toggleChanges = () => {
    changes.value = !changes.value;
    // Marks below the fold look like nothing changed on a phone: bring the first one into view.
    const first = changes.value && body.current ? firstChange(body.current) : null;
    if (first) requestAnimationFrame(() => first.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  const canComment = artifact.permissions.comment && latest;
  const where = (key: string) =>
    `${page.title ?? page.key} / ${page.outline?.find((o) => o.id === key.split("/")[0])?.title ?? key}`;

  // Only when the marks change: redrawing them on every poll would disturb a selection in progress.
  useEffect(() => {
    if (!body.current || !links.value) return;
    const wanted = new Set(
      links.value.outgoing.filter((link) => !link.exists).map((link) => artifactHref(link)),
    );
    for (const anchor of body.current.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (wanted.has(anchor.getAttribute("href") ?? "")) {
        anchor.classList.add("wanted");
        anchor.title = "Not written yet";
      }
    }
  }, [links.value, loaded.value]);
  const marks = JSON.stringify(all.map((t) => [t.id, t.n, t.status, t.anchorState, t.anchor]));
  useEffect(() => {
    if (body.current && loaded.value > 0) {
      decorate(body.current, all, (id) => {
        openId.value = id;
      });
    }
  }, [marks, loaded.value]);

  useEffect(() => {
    if (!canComment) return;
    const onChange = () => {
      const quote = body.current ? quoteFromSelection(body.current) : null;
      if (!quote) {
        selection.value = null;
        return;
      }
      selection.value = {
        x: quote.rect.left,
        y: quote.rect.bottom + 54,
        draft: {
          pageKey: page.key,
          anchor: { type: "text", blockKey: quote.blockKey, quote: quote.quote },
          where: where(quote.blockKey),
          quote: quote.quote.exact,
        },
      };
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  });

  useEffect(() => {
    writeStored("artifacts.read.size", String(size.value));
    if (font.value !== "theme") writeStored("artifacts.read.font", font.value);
    writeStored("artifacts.read.theme", theme.value);
  }, [size.value, font.value, theme.value]);

  // Light or Dark is the reader's, for this page only: the colours follow data-theme (tokens.css), and
  // leaving the article gives the rest of the app back to the system.
  useEffect(() => {
    const root = document.documentElement;
    if (theme.value === "auto") return;
    root.dataset.theme = theme.value;
    root.style.colorScheme = theme.value;
    return () => {
      delete root.dataset.theme;
      root.style.removeProperty("color-scheme");
    };
  }, [theme.value]);

  useEffect(() => {
    let live = true;
    const article = (n: number) =>
      api<string>(articleUrl(artifact.id, n, page.key), { text: true }).then(
        // Sanitized by the server at commit (05); only `artifacts:blob/` needs mapping.
        (html) => html.replaceAll("artifacts:blob/", renderUrl(artifact.id, "")),
      );
    // A page the version before didn't have answers 404: all of it is new.
    const before = previous ? article(previous).catch(() => null) : Promise.resolve(undefined);
    failed.value = false;
    Promise.all([article(version), before]).then(
      ([html, old]) => {
        if (!live || !body.current) return;
        // The publisher's theme stops at this element: the review UI around it keeps its own look.
        for (const [name, value] of Object.entries(articleStyle(page.theme))) {
          body.current.style.setProperty(name, value);
        }
        body.current.innerHTML = html;
        changed.value = old === undefined ? null : old === null ? "new" : markChanges(body.current, old);
        loaded.value += 1;
      },
      () => {
        if (live) failed.value = true;
      },
    );
    return () => {
      live = false;
    };
  }, [artifact.id, version, previous, page, attempt.value]);
  useEffect(() => {
    let sent = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - sent < 10_000) return;
      sent = now;
      post(`/api/artifacts/${artifact.id}/seen`, {
        version,
        pageKey: page.key,
        position: { scrollY: scrollY },
      }).catch(() => {});
    };
    post(`/api/artifacts/${artifact.id}/seen`, { version }).catch(() => {});
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [artifact.id, version, page.key]);

  return (
    <div class="reader has-panel">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: picking a block is a touch shortcut; selecting text works by keyboard */}
      <article
        class={`article${changes.value ? " show-changes" : ""}${picking.value ? " picking" : ""}`}
        onClick={pick}
        style={{
          "--read-size": `${size.value}px`,
          ...(font.value === "theme"
            ? {}
            : { "--read-font": font.value === "serif" ? "var(--serif)" : "var(--ui)" }),
        }}
      >
        {(changes.value || (typeof changed.value === "number" && changed.value > 0)) && (
          <div class="banner" style="margin-bottom:16px">
            <Diff class="chev" style="color:var(--agent-word)" />
            <span class="grow">
              {changed.value === null
                ? "This is the first version."
                : changed.value === "new"
                  ? `This page is new in v${version}.`
                  : changed.value === 0
                    ? `Nothing on this page changed since v${previous}.`
                    : `Changed in ${plural(changed.value, "place")} since v${previous}.`}
              {changes.value && typeof changed.value === "number" && changed.value > 0 && (
                <span class="chg-key">
                  <ins class="chg">Added</ins> <del class="chg gap-l">Removed</del>
                </span>
              )}
            </span>
            {typeof changed.value === "number" && changed.value > 0 && (
              <button type="button" class="vchip" onClick={toggleChanges}>
                {changes.value ? "Hide" : "Show"}
              </button>
            )}
          </div>
        )}
        <div class="meta">
          <span>{page.title ?? page.key}</span>
          <span>{page.readingMinutes} min read</span>
          <span class="word agent">v{version}</span>
        </div>
        {failed.value && (
          <LoadFailed
            retry={() => {
              attempt.value += 1;
            }}
          />
        )}
        {links.value?.untrusted && (
          <p class="wiki-trust word">
            <ShieldAlert />
            {links.value.role === "source" ? "Untrusted source" : "Written from untrusted sources"}
            {links.value.origin && `, ${hostOf(links.value.origin)}`}
          </p>
        )}
        <div ref={body} />
        {linksFailed.value && <p class="ss">Sources and links could not be loaded.</p>}
        {links.value && (
          <footer class="wiki-footer">
            {(
              [
                ["Sources", links.value.sources],
                ["Linked from", links.value.backlinks],
              ] as const
            )
              // A source is where pages come from; it cites nothing itself.
              .filter(([title]) => title !== "Sources" || links.value?.role !== "source")
              .map(([title, items]) => (
                <section key={title}>
                  <h2>{title}</h2>
                  {items.length === 0 ? (
                    <p class="ss">{title === "Sources" ? "No sources cited." : "No pages link here yet."}</p>
                  ) : (
                    items.map((link) => (
                      <a class="li" href={artifactHref(link)} key={`${link.project}/${link.slug}`}>
                        <div class="grow">
                          <div class="tt">{link.title ?? link.slug}</div>
                          {link.summary && <div class="ss">{link.summary}</div>}
                          {link.untrusted && (
                            <span class="word">
                              <ShieldAlert />
                              Untrusted source{link.origin ? `, ${hostOf(link.origin)}` : ""}
                            </span>
                          )}
                        </div>
                      </a>
                    ))
                  )}
                </section>
              ))}
          </footer>
        )}
      </article>
      <PageCapsule
        box={capsule}
        liquid
        title={page.title ?? page.key}
        subtitle={artifact.title}
        version={version}
        onPages={onPages}
        onVersions={onVersions}
      >
        <button
          type="button"
          class="round"
          aria-label="Reading settings"
          style="font:700 15px var(--serif)"
          onClick={() => {
            settings.value = !settings.value;
          }}
        >
          Aa
        </button>
      </PageCapsule>
      {settings.value && (
        <div class="popover glass liquid thick">
          <span class="gh">Text size</span>
          <div class="seg">
            {SIZES.map((value, index) => (
              <button
                type="button"
                key={value}
                aria-pressed={size.value === value}
                onClick={() => {
                  size.value = value;
                }}
              >
                {["Small", "Medium", "Large"][index]}
              </button>
            ))}
          </div>
          <span class="gh">Theme</span>
          <div class="seg">
            {(["light", "dark", "auto"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={theme.value === value}
                onClick={() => {
                  theme.value = value;
                }}
              >
                {capitalize(value)}
              </button>
            ))}
          </div>
          <span class="gh">Typeface</span>
          <div class="seg">
            {(["serif", "sans"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={font.value === value}
                onClick={() => {
                  font.value = value;
                }}
              >
                {value === "serif" ? "Serif" : "Sans"}
              </button>
            ))}
          </div>
        </div>
      )}
      <div ref={bar} class={`vbar glass liquid${draft.value ? " hidden" : ""}`}>
        <i ref={pool} class="pool" />
        <button
          type="button"
          class="vb"
          onClick={() => {
            contents.value = true;
          }}
        >
          <List />
          <span class="l">Contents</span>
        </button>
        <button type="button" class="vb" aria-pressed={changes.value} onClick={toggleChanges}>
          <Diff />
          <span class="l">Changes</span>
        </button>
        <i class="vsep" />
        {canComment && (
          <button
            type="button"
            class="vb"
            aria-pressed={picking.value}
            onClick={() => {
              picking.value = !picking.value;
            }}
          >
            <MessageCircle />
            <span class="l">Comment</span>
          </button>
        )}
        <button
          type="button"
          class="vb"
          onClick={() => {
            listOpen.value = true;
          }}
        >
          <MessagesSquare />
          <span class="l">Comments</span>
          {review.openCount > 0 && <b class="count">{review.openCount}</b>}
        </button>
      </div>
      {picking.value && <div class="hint glass liquid thick">Tap a paragraph</div>}
      {selection.value && !draft.value && (
        <button
          type="button"
          class="btn mark selbtn"
          style={{
            left: `${Math.max(12, selection.value.x)}px`,
            // A long paragraph can end below the screen. This keeps the button on it, above the bar.
            top: `min(${selection.value.y}px, calc(100dvh - env(safe-area-inset-bottom) - 138px))`,
          }}
          onClick={() => {
            draft.value = selection.value?.draft ?? null;
            selection.value = null;
          }}
        >
          <MessageCircle />
          Comment
        </button>
      )}
      {review.sheets}
      {contents.value && (
        <Sheet
          title="Contents"
          onClose={() => {
            contents.value = false;
          }}
        >
          <div class="group">
            {page.outline?.map((entry) => (
              <button
                type="button"
                class="li btn-li"
                style={{ paddingLeft: `${16 + (entry.level - 1) * 14}px` }}
                key={entry.id}
                onClick={() => {
                  contents.value = false;
                  body.current?.querySelector(`[data-block="${CSS.escape(entry.id)}"]`)?.scrollIntoView();
                }}
              >
                <div class="grow">
                  <div class="tt">{entry.title}</div>
                </div>
                {page.blocks.some((block) => block.changed && block.key.split("/")[0] === entry.id) && (
                  <span class="dot" title="Changed" />
                )}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}
