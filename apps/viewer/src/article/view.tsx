import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { List, Menu, Triangle } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { api, post } from "../api.ts";
import { Sheet } from "../components/sheets.tsx";
import { plural } from "../format.ts";

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
  onPages(): void;
  onVersions(): void;
};

const SIZES = [17, 19, 21];
const stored = (key: string, fallback: string) => localStorage.getItem(`artifacts.read.${key}`) ?? fallback;

export function ArticleView({ artifact, page, version, onPages, onVersions }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const contents = useSignal(false);
  const settings = useSignal(false);
  const changes = useSignal(false);
  const size = useSignal(Number(stored("size", "19")));
  const font = useSignal(stored("font", "serif"));
  const theme = useSignal(stored("theme", "auto"));
  const changedCount = page.blocks.filter((block) => block.changed).length;

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
      <article
        class={`article${changes.value ? " show-changes" : ""}`}
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
      </div>
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
