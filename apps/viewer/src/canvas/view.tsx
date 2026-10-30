import type { Artifact, CanvasFrame, Thread } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Images, List, Menu, MessageCircle, Move } from "lucide-preact";
import { createPortal } from "preact/compat";
import { useEffect, useRef } from "preact/hooks";
import {
  CommentSheet,
  CommentsPanel,
  CommentsSheet,
  type Draft,
  ThreadSheet,
} from "../components/review.tsx";
import { Sheet } from "../components/sheets.tsx";
import { renderUrl } from "../format.ts";
import { LiveFrame, savedNotice } from "../live/frame.tsx";
import type { Remote } from "../poll.ts";
import { type Board, CanvasEngine, type Pin } from "./engine.ts";

export type CanvasPage = { key: string; title: string | null; boards: Board[]; frames: CanvasFrame[] };

type Props = {
  artifact: Artifact;
  page: CanvasPage;
  version: number;
  latest: boolean;
  threads: Remote<Thread[]>;
  onPages(): void;
  onVersions(): void;
};

/** Lays the live page over the frame's picture, and puts the picture back on Done (08). */
function TryIt({
  artifact,
  frame,
  version,
  engine,
}: {
  artifact: Artifact;
  frame: CanvasFrame;
  version: number;
  engine: CanvasEngine | null;
}) {
  const scope = useSignal<"shared" | "me" | null>(null);
  const host = useSignal<HTMLElement | null>(null);
  useEffect(() => {
    host.value = engine?.liveHost(frame.key) ?? null;
    return () => engine?.closeLive(frame.key);
  }, [engine, frame.key, host]);
  return (
    <>
      {scope.value && (
        <div class="notice glass">{savedNotice(scope.value)}. Its author can see what's saved.</div>
      )}
      {host.value &&
        createPortal(
          <LiveFrame
            artifact={artifact}
            version={version}
            path={frame.livePath as string}
            width={frame.w}
            height={frame.h}
            onUse={(used) => {
              scope.value = used;
            }}
          />,
          host.value,
        )}
    </>
  );
}

export function CanvasView({ artifact, page, version, latest, threads, onPages, onVersions }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const engine = useRef<CanvasEngine | null>(null);
  const focus = useSignal<CanvasFrame | null>(null);
  const framesOpen = useSignal(false);
  const tab = useSignal<"all" | "open" | "changed">("all");
  const commenting = useSignal(false);
  const draft = useSignal<(Draft & { pin: Pin }) | null>(null);
  const openId = useSignal<string | null>(null);
  const listOpen = useSignal(false);
  const trying = useSignal<CanvasFrame | null>(null);
  const all = (threads.data.value ?? []).filter((thread) => thread.pageKey === page.key);
  const openThread = all.find((thread) => thread.id === openId.value) ?? null;
  const canComment = artifact.permissions.comment && latest;
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
        onTap(frame, at) {
          if (!commenting.value || !frame) return;
          const x = (at.x - frame.x) / frame.w;
          const y = (at.y - frame.y) / frame.h;
          commenting.value = false;
          draft.value = {
            pageKey: page.key,
            anchor: { type: "frame", frameKey: frame.key, x, y },
            where: `${frame.board} / ${frame.title ?? frame.key}`,
            pin: { id: "draft", n: 0, frameKey: frame.key, x, y, draft: true },
          };
          // The canvas moves so the pin stays above the sheet (06).
          instance.showPoint(at.x, at.y, Math.max(120, (root.current?.clientHeight ?? 600) * 0.3));
        },
        onPin(pin) {
          if (!pin.draft) openId.value = pin.id;
        },
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

  useEffect(() => {
    if (engine.current) engine.current.commenting = commenting.value;
    root.current?.classList.toggle("commenting", commenting.value);
  }, [commenting.value]);

  // Pins follow the threads, polled every 10 seconds. Orphaned threads live in the list only.
  const pins: Pin[] = all.flatMap((thread) =>
    thread.anchor?.type === "frame" && thread.anchorState !== "orphaned"
      ? [
          {
            id: thread.id,
            n: thread.n,
            frameKey: thread.anchor.frameKey,
            x: thread.anchor.x,
            y: thread.anchor.y,
            done: thread.status === "resolved",
            active: thread.id === openId.value,
          },
        ]
      : [],
  );
  useEffect(() => {
    engine.current?.setPins(draft.value ? [...pins, draft.value.pin] : pins);
  });

  // ?c=<n> opens a thread, once.
  const deepLinked = useRef(false);
  useEffect(() => {
    const n = Number(new URLSearchParams(location.search).get("c"));
    if (deepLinked.current || !n || all.length === 0) return;
    const thread = all.find((entry) => entry.n === n);
    if (!thread) return;
    deepLinked.current = true;
    openId.value = thread.id;
    if (thread.anchor?.type === "frame") engine.current?.focusFrame(thread.anchor.frameKey, false);
  });

  const frame = focus.value;
  const boardTitle = page.boards.find((board) => board.key === frame?.board)?.title ?? "";
  const siblings = frame ? page.frames.filter((f) => f.board === frame.board) : [];
  const openOn = (key: string) =>
    all.filter((t) => t.status === "open" && t.anchor?.type === "frame" && t.anchor.frameKey === key).length;
  const shown = page.frames.filter(
    (f) => tab.value === "all" || (tab.value === "changed" ? f.changed : openOn(f.key) > 0),
  );
  const openCount = all.filter((thread) => thread.status === "open").length;
  const select = (thread: Thread) => {
    listOpen.value = false;
    openId.value = thread.id;
    if (thread.anchor?.type === "frame" && thread.anchorState !== "orphaned") {
      engine.current?.focusFrame(thread.anchor.frameKey);
    }
  };
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
              ? `${page.title ?? page.key} / ${boardTitle}, ${siblings.findIndex((f) => f.key === frame.key) + 1} of ${siblings.length}`
              : artifact.title}
          </span>
        </button>
        <button type="button" class="vchip" aria-label="Version history" onClick={onVersions}>
          v{version}
        </button>
        {frame?.live && (
          <button
            type="button"
            class="btn soft fit"
            onClick={() => {
              trying.value = trying.value ? null : frame;
            }}
          >
            {trying.value ? "Done" : "Try it"}
          </button>
        )}
      </div>
      {trying.value && (
        <TryIt artifact={artifact} frame={trying.value} version={version} engine={engine.current} />
      )}
      <div class="vbar glass">
        <button
          type="button"
          class="vb"
          aria-pressed={!commenting.value}
          onClick={() => {
            commenting.value = false;
          }}
        >
          <Move />
          Move
        </button>
        {canComment && (
          <button
            type="button"
            class="vb"
            aria-pressed={commenting.value}
            onClick={() => {
              commenting.value = !commenting.value;
            }}
          >
            <MessageCircle />
            Comment
          </button>
        )}
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
        <button
          type="button"
          class="vb"
          onClick={() => {
            listOpen.value = true;
          }}
        >
          <List />
          Comments
          {openCount > 0 && <b class="count">{openCount}</b>}
        </button>
      </div>
      {commenting.value && <div class="hint glass">Tap a spot to comment</div>}
      <CommentsPanel threads={all} onOpen={select} />
      {draft.value && (
        <CommentSheet
          artifact={artifact}
          version={version}
          draft={draft.value}
          onClose={() => {
            draft.value = null;
          }}
          onPosted={(thread) => {
            draft.value = null;
            threads.refresh().then(() => {
              openId.value = thread.id;
            });
          }}
        />
      )}
      {openThread && (
        <ThreadSheet
          artifact={artifact}
          thread={openThread}
          title={`${openThread.n}, ${page.frames.find((f) => openThread.anchor?.type === "frame" && f.key === openThread.anchor.frameKey)?.title ?? page.title ?? page.key}`}
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
          onOpen={select}
          onClose={() => {
            listOpen.value = false;
          }}
        />
      )}
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
              aria-pressed={tab.value === "open"}
              onClick={() => {
                tab.value = "open";
              }}
            >
              Open {openCount}
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
                      {openOn(item.key) > 0 && <b class="count">{openOn(item.key)}</b>}
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
