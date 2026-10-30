import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { ChevronLeft, ChevronRight, Menu, X } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { renderUrl } from "../format.ts";

type Item = { hash: string; caption?: string; type?: string };
export type GalleryPage = { key: string; title: string | null; meta: { items: Item[] } };

const isVideo = (item: Item) => item.type?.startsWith("video/");

function Media({ artifact, item, controls }: { artifact: Artifact; item: Item; controls?: boolean }) {
  const url = renderUrl(artifact.id, item.hash);
  // A video in the grid is a still: autoplay on a phone's cell connection isn't what anyone asked for.
  return isVideo(item) ? (
    // biome-ignore lint/a11y/useMediaCaption: an agent's upload, which has none to offer.
    <video src={url} controls={controls} playsInline preload="metadata" />
  ) : (
    <img src={url} alt={item.caption ?? ""} loading="lazy" />
  );
}

/** A grid that opens into a swipeable lightbox (SPEC §4). */
export function GalleryView({
  artifact,
  page,
  version,
  onPages,
  onVersions,
}: {
  artifact: Artifact;
  page: GalleryPage;
  version: number;
  onPages(): void;
  onVersions(): void;
}) {
  const open = useSignal<number | null>(null);
  const items = page.meta.items;
  const touch = useRef<number | null>(null);
  const step = (by: number) => {
    if (open.value !== null) open.value = (open.value + by + items.length) % items.length;
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open.value === null) return;
      if (event.key === "ArrowRight") step(1);
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "Escape") open.value = null;
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  const current = open.value === null ? null : items[open.value];
  return (
    <div class="on-canvas gallery">
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
      </div>
      <div class="grid-g">
        {items.map((item, index) => (
          <button
            type="button"
            class="cell-g"
            key={item.hash + index}
            aria-label={item.caption ?? `Item ${index + 1}`}
            onClick={() => {
              open.value = index;
            }}
          >
            <Media artifact={artifact} item={item} />
            {item.caption && <span>{item.caption}</span>}
          </button>
        ))}
      </div>
      {current && (
        <div
          class="light"
          role="dialog"
          aria-label={current.caption ?? "Item"}
          onTouchStart={(event) => {
            touch.current = event.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(event) => {
            const end = event.changedTouches[0]?.clientX;
            if (touch.current !== null && end !== undefined && Math.abs(end - touch.current) > 40) {
              step(end < touch.current ? 1 : -1);
            }
            touch.current = null;
          }}
        >
          <button
            type="button"
            class="icon-btn close"
            aria-label="Close"
            onClick={() => {
              open.value = null;
            }}
          >
            <X />
          </button>
          <Media artifact={artifact} item={current} controls />
          {current.caption && <p>{current.caption}</p>}
          {items.length > 1 && (
            <>
              <button type="button" class="icon-btn prev" aria-label="Previous" onClick={() => step(-1)}>
                <ChevronLeft />
              </button>
              <button type="button" class="icon-btn next" aria-label="Next" onClick={() => step(1)}>
                <ChevronRight />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
