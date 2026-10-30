import type { Artifact, CanvasFrame } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Images, Menu, MessageCircle, Move } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { Sheet } from "../components/sheets.tsx";
import { renderUrl } from "../format.ts";
import { type Board, CanvasEngine } from "./engine.ts";

export type CanvasPage = { key: string; title: string | null; boards: Board[]; frames: CanvasFrame[] };

type Props = {
  artifact: Artifact;
  page: CanvasPage;
  version: number;
  latest: boolean;
  onPages(): void;
  onVersions(): void;
};

export function CanvasView({ artifact, page, version, onPages, onVersions }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const engine = useRef<CanvasEngine | null>(null);
  const focus = useSignal<CanvasFrame | null>(null);
  const framesOpen = useSignal(false);
  const tab = useSignal<"all" | "changed">("all");
  useEffect(() => {
    if (!root.current || !world.current || !overlay.current) return;
    const instance = new CanvasEngine(
      root.current,
      world.current,
      overlay.current,
      page.frames,
      page.boards,
      {
        renderUrl: (hash) => renderUrl(artifact.id, hash),
        onTap() {},
        onPin() {},
        onFocus(frame) {
          focus.value = frame;
          const url = new URL(location.href);
          url.hash = frame ? `frame=${frame.key}` : "";
          history.replaceState(history.state, "", url);
        },
      },
    );
    engine.current = instance;
    const wanted = /frame=([\w-]+)/.exec(location.hash)?.[1];
    instance.fitAll();
    if (wanted) instance.focusFrame(wanted, false);
    (window as unknown as { __canvas?: CanvasEngine }).__canvas = instance;

    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "0") instance.fitAll(true);
      if (event.key === "1") instance.zoomTo(1);
      if (event.key === "n") instance.step(1);
      if (event.key === "p") instance.step(-1);
    };
    const onHash = () => {
      const key = /frame=([\w-]+)/.exec(location.hash)?.[1];
      if (key) instance.focusFrame(key);
    };
    addEventListener("keydown", onKey);
    addEventListener("hashchange", onHash);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("hashchange", onHash);
      instance.destroy();
      engine.current = null;
    };
  }, [page, version, artifact.id]);

  const frame = focus.value;
  const siblings = frame ? page.frames.filter((f) => f.board === frame.board) : [];
  const shown = page.frames.filter((f) => tab.value === "all" || f.changed);
  const changedCount = page.frames.filter((f) => f.changed).length;

  return (
    <div class="on-canvas">
      <div class="cv" ref={root} role="application" aria-label={`${page.title ?? page.key} canvas`}>
        <div class="world" ref={world} />
        <div class="overlay" ref={overlay} />
      </div>
      <div class="capsule glass">
        <button type="button" class="icon-btn" aria-label="Pages" onClick={onPages}>
          <Menu />
        </button>
        <button type="button" class="where" onClick={onPages}>
          <b>{frame ? (frame.title ?? frame.key) : (page.title ?? page.key)}</b>
          <span>
            {frame
              ? `${page.title ?? page.key} / ${frame.board}, ${siblings.indexOf(frame) + 1} of ${siblings.length}`
              : artifact.title}
          </span>
        </button>
        <button type="button" class="vchip" aria-label="Version history" onClick={onVersions}>
          v{version}
        </button>
      </div>
      <div class="vbar glass">
        <button type="button" class="vb" aria-pressed="true">
          <Move />
          Move
        </button>
        <button type="button" class="vb">
          <MessageCircle />
          Comment
        </button>
        <i class="vsep" />
        <button
          type="button"
          class="vb"
          onClick={() => {
            framesOpen.value = true;
          }}
        >
          <Images />
          Frames
        </button>
      </div>
      {framesOpen.value && (
        <Sheet
          title="Frames"
          onClose={() => {
            framesOpen.value = false;
          }}
        >
          <div class="seg">
            <button
              type="button"
              aria-pressed={tab.value === "all"}
              onClick={() => {
                tab.value = "all";
              }}
            >
              All {page.frames.length}
            </button>
            <button
              type="button"
              aria-pressed={tab.value === "changed"}
              onClick={() => {
                tab.value = "changed";
              }}
            >
              Changed {changedCount}
            </button>
          </div>
          {page.boards.map((board) => {
            const list = shown.filter((f) => f.board === board.key);
            if (list.length === 0) return null;
            return (
              <>
                <span class="gh">{board.title}</span>
                <div class="group" key={board.key}>
                  {list.map((item) => (
                    <button
                      type="button"
                      class={`li btn-li${frame?.key === item.key ? " on" : ""}`}
                      key={item.key}
                      onClick={() => {
                        framesOpen.value = false;
                        engine.current?.focusFrame(item.key);
                      }}
                    >
                      <span class="th frame">
                        <img src={renderUrl(artifact.id, item.renders.thumb)} alt="" loading="lazy" />
                      </span>
                      <div class="grow">
                        <div class="tt">{item.title ?? item.key}</div>
                      </div>
                      {item.changed && <span class="dot" title="Changed" />}
                    </button>
                  ))}
                </div>
              </>
            );
          })}
        </Sheet>
      )}
    </div>
  );
}
