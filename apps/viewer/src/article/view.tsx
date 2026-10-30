import type { Artifact, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { List, Menu, MessageCircle, MessagesSquare, Triangle } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { api, post } from "../api.ts";
import {
  CommentSheet,
  CommentsPanel,
  CommentsSheet,
  type Draft,
  ThreadSheet,
} from "../components/review.tsx";
import { Sheet } from "../components/sheets.tsx";
import { plural } from "../format.ts";
import type { Remote } from "../poll.ts";
import { decorate, quoteFromSelection } from "./marks.ts";

export type ArticlePage = {
  key: string;
  title: string | null;
  readingMinutes: number;
  outline: { id: string; title: string; level: number }[];
  blocks: { key: string; contentHash: string; changed: boolean }[];
};

type Props = {
  artifact: Artifact;
  page: ArticlePage;
  version: number;
  latest: boolean;
  threads: Remote<Thread[]>;
  onPages(): void;
  onVersions(): void;
};

const SIZES = [17, 19, 21];
const stored = (key: string, fallback: string) => localStorage.getItem(`artifacts.read.${key}`) ?? fallback;

export function ArticleView({ artifact, page, version, latest, threads, onPages, onVersions }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const contents = useSignal(false);
  const settings = useSignal(false);
  const changes = useSignal(false);
  const pick = (event: MouseEvent) => {
    if (!picking.value) return;
    const block = (event.target as HTMLElement).closest<HTMLElement>("[data-block]");
    const key = block?.dataset.block;
    if (!key) return;
    picking.value = false;
    draft.value = { pageKey: page.key, anchor: { type: "block", blockKey: key }, where: where(key) };
  };
  const size = useSignal(Number(stored("size", "19")));
  const font = useSignal(stored("font", "serif"));
  const theme = useSignal(stored("theme", "auto"));
  const changedCount = page.blocks.filter((block) => block.changed).length;
  const loaded = useSignal(0);
  const draft = useSignal<Draft | null>(null);
  const picking = useSignal(false);
  const selection = useSignal<{ draft: Draft; x: number; y: number } | null>(null);
  const openId = useSignal<string | null>(null);
  const listOpen = useSignal(false);
  const all = (threads.data.value ?? []).filter((thread) => thread.pageKey === page.key);
  const openThread = all.find((thread) => thread.id === openId.value) ?? null;
  const openCount = all.filter((thread) => thread.status === "open").length;
  const canComment = artifact.permissions.comment && latest;
  const where = (key: string) =>
    `${page.title ?? page.key} / ${page.outline.find((o) => o.id === key.split("/")[0])?.title ?? key}`;

  // Only when the marks change: redrawing them on every poll would disturb a selection in progress.
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
    localStorage.setItem("artifacts.read.size", String(size.value));
    localStorage.setItem("artifacts.read.font", font.value);
    localStorage.setItem("artifacts.read.theme", theme.value);
    if (theme.value === "auto") document.documentElement.style.removeProperty("color-scheme");
    else document.documentElement.style.colorScheme = theme.value;
  }, [size.value, font.value, theme.value]);

  useEffect(() => {
    let live = true;
    api<string>(`/api/artifacts/${artifact.id}/v/${version}/article/${page.key}`, { text: true }).then(
      (html) => {
        if (!live || !body.current) return;
        // Sanitized by the server at commit (05); only `artifacts:blob/` needs mapping.
        body.current.innerHTML = html.replaceAll("artifacts:blob/", `/api/artifacts/${artifact.id}/r/`);
        for (const block of page.blocks) {
          if (block.changed) {
            body.current
              .querySelector(`[data-block="${CSS.escape(block.key)}"]`)
              ?.setAttribute("data-changed", "");
          }
        }
        loaded.value += 1;
      },
    );
    return () => {
      live = false;
    };
  }, [artifact.id, version, page]);
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
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: picking a block is a touch shortcut; selecting text works by keyboard */}
      <article
        class={`article${changes.value ? " show-changes" : ""}${picking.value ? " picking" : ""}`}
        onClick={pick}
        style={{
          "--read-size": `${size.value}px`,
          "--read-font": font.value === "serif" ? "var(--serif)" : "var(--ui)",
        }}
      >
        {changedCount > 0 && !changes.value && (
          <div class="banner" style="margin-bottom:16px">
            <span class="grow">{plural(changedCount, "section")} changed since the last version.</span>
            <button
              type="button"
              class="vchip"
              onClick={() => {
                changes.value = true;
              }}
            >
              Show
            </button>
          </div>
        )}
        <div class="meta">
          <span>{page.title ?? page.key}</span>
          <span>{page.readingMinutes} min read</span>
          <span class="word agent">v{version}</span>
        </div>
        <div ref={body} />
      </article>
      <div class="capsule glass">
        <button type="button" class="icon-btn" aria-label="Pages" onClick={onPages}>
          <Menu />
        </button>
        <button type="button" class="where" onClick={onPages}>
          <b>{page.title ?? page.key}</b>
          <span>{artifact.title}</span>
        </button>
        <button type="button" class="vchip" aria-label="Version history" onClick={onVersions}>
          v{version}
        </button>
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
      </div>
      {settings.value && (
        <div class="popover glass">
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
                {value[0]?.toUpperCase()}
                {value.slice(1)}
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
      <div class="vbar glass">
        <button
          type="button"
          class="vb"
          onClick={() => {
            contents.value = true;
          }}
        >
          <List />
          Contents
        </button>
        <button
          type="button"
          class="vb"
          aria-pressed={changes.value}
          onClick={() => {
            changes.value = !changes.value;
          }}
        >
          <Triangle />
          Changes
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
            Comment
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
          Comments
          {openCount > 0 && <b class="count">{openCount}</b>}
        </button>
      </div>
      {picking.value && <div class="hint glass">Tap a paragraph</div>}
      {selection.value && !draft.value && (
        <button
          type="button"
          class="btn mark selbtn"
          style={{ left: `${Math.max(12, selection.value.x)}px`, top: `${selection.value.y}px` }}
          onClick={() => {
            draft.value = selection.value?.draft ?? null;
            selection.value = null;
          }}
        >
          <MessageCircle />
          Comment
        </button>
      )}
      <CommentsPanel
        threads={all}
        onOpen={(thread) => {
          openId.value = thread.id;
        }}
      />
      {draft.value && (
        <CommentSheet
          artifact={artifact}
          version={version}
          draft={draft.value}
          onClose={() => {
            draft.value = null;
          }}
          onPosted={() => {
            draft.value = null;
            threads.refresh();
          }}
        />
      )}
      {openThread && (
        <ThreadSheet
          artifact={artifact}
          thread={openThread}
          title={`Comment ${openThread.n}`}
          base={`/${artifact.project}/${artifact.slug}`}
          threads={threads}
          onClose={() => {
            openId.value = null;
          }}
        />
      )}
      {listOpen.value && (
        <CommentsSheet
          threads={all}
          onOpen={(thread) => {
            listOpen.value = false;
            openId.value = thread.id;
          }}
          onClose={() => {
            listOpen.value = false;
          }}
        />
      )}
      {contents.value && (
        <Sheet
          title="Contents"
          onClose={() => {
            contents.value = false;
          }}
        >
          <div class="group">
            {page.outline.map((entry) => (
              <button
                type="button"
                class="li btn-li"
                style={{ paddingLeft: `${16 + (entry.level - 1) * 14}px` }}
                key={entry.id}
                onClick={() => {
                  contents.value = false;
                  body.current
                    ?.querySelector(`[data-block="${CSS.escape(entry.id)}"]`)
                    ?.scrollIntoView({ behavior: "smooth" });
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
    </>
  );
}
