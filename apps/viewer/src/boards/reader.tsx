import "./board.css";
import type { Artifact, Author, Thread } from "@artifacts/schema";
import type { BoardSnapshot, BoardState, BoardVersionView } from "@artifacts/schema/boards";
import { useSignal } from "@preact/signals";
import { Eye, List, Maximize, MessageCircle, Pencil } from "lucide-preact";
import type { ComponentType } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api } from "../api.ts";
import { CanvasEngine, type Pin } from "../canvas/engine.ts";
import { canvasCommand } from "../canvas/keys.ts";
import { PageCapsule } from "../components/shell.tsx";
import { useEvents } from "../events.ts";
import { renderUrl } from "../paths.ts";
import type { Remote } from "../poll.ts";
import type { Draft } from "../review/sheets.tsx";
import { useReview } from "../review/use-review.tsx";
import { me } from "../session.ts";
import type { EditorProps } from "./editor.tsx";
import {
  anchorPoint,
  hitTest,
  localUV,
  objectBounds,
  objectName,
  sceneBounds,
  sceneOf,
  worldPose,
} from "./geometry.ts";
import { Outline } from "./outline.tsx";
import { type AuthorInfo, BoardLayer } from "./render.ts";

/**
 * A native board, reading (14, "Viewer"): the immutable checkpoint drawn by the lightweight renderer
 * into the canvas engine, with the Objects outline and object comment pins. The editor (tools, Yjs,
 * sync) is its own chunk, fetched only on Edit.
 */
type ObjectAnchor = { type: "object"; object: string; u: number; v: number; checkpoint: number };
const objectAnchor = (thread: Thread) => {
  const anchor = thread.anchor as unknown as ObjectAnchor | null;
  return anchor?.type === "object" ? anchor : null;
};

export const assetUrl = (artifactId: string, hash: string, version?: number) =>
  `/api/artifacts/${artifactId}/board/assets/${hash}${version ? `?version=${version}` : ""}`;

export function authorLookup(authors: Author[]) {
  const byKey = new Map(authors.map((a) => [a.key, a]));
  return (key: string): AuthorInfo | null => {
    const author = byKey.get(key);
    return author
      ? { name: author.kind === "agent" ? (author.agent ?? author.name) : author.name, kind: author.kind }
      : null;
  };
}

const emptySnapshot = (page: string): BoardSnapshot => ({
  schema: 1,
  page,
  objects: [],
  deleted: [],
  assets: [],
});

/**
 * Edit on a wiki canvas with no native checkpoint yet: the BoardState says whether it is editable, and
 * the editor chunk loads on the tap. The server seeds the draft from the page's frames on first sync.
 */
export function useBoardEdit(artifact: Artifact, pageKey: string | false, latest: boolean) {
  const state = useSignal<BoardState | null>(null);
  const editor = useSignal<ComponentType<EditorProps> | null>(null);
  const open = useSignal(false);
  const wiki = artifact.projectKind === "wiki" && !!pageKey;
  useEffect(() => {
    if (!wiki) return;
    api<BoardState>(`/api/artifacts/${artifact.id}/board`).then(
      (value) => {
        state.value = value;
      },
      () => {
        state.value = null;
      },
    );
  }, [artifact.id, wiki]);
  const board = state.value;
  if (!wiki || !board?.canEdit || !board.editable || !latest) return { key: null, editor: null };
  const Editor = editor.value;
  return {
    key: (
      <button
        type="button"
        class="btn mark edit-key"
        onClick={() =>
          import("./editor.tsx").then((module) => {
            editor.value = module.BoardEditor;
            open.value = true;
          })
        }
      >
        <Pencil />
        Edit
      </button>
    ),
    editor:
      open.value && Editor ? (
        <Editor
          artifact={artifact}
          pageKey={pageKey as string}
          state={board}
          version={board.version}
          snapshot={emptySnapshot(pageKey as string)}
          authors={[]}
          onClose={() => {
            open.value = false;
          }}
        />
      ) : null,
  };
}

type Props = {
  artifact: Artifact;
  page: { key: string; title: string | null };
  version: number;
  latest: boolean;
  threads: Remote<Thread[]>;
  onPages(): void;
  onVersions(): void;
  /** No native snapshot for this version (or no server for it yet): the frame canvas reads it as before. */
  onLegacy(): void;
};

export function BoardReader({
  artifact,
  page,
  version,
  latest,
  threads,
  onPages,
  onVersions,
  onLegacy,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const engine = useRef<CanvasEngine | null>(null);
  const layer = useRef<BoardLayer | null>(null);
  const view = useSignal<BoardVersionView | null>(null);
  const state = useSignal<BoardState | null>(null);
  const outline = useSignal(false);
  const selected = useSignal<string | null>(null);
  const eye = useSignal(false);
  const commenting = useSignal(false);
  const editor = useSignal<ComponentType<EditorProps> | null>(null);
  const editing = useSignal(false);
  const opening = useSignal(false);
  const { query } = useLocation();
  const base = `/api/artifacts/${artifact.id}`;

  useEffect(() => {
    let live = true;
    api<BoardVersionView>(`${base}/board/snapshot?version=${version}`).then(
      (value) => {
        if (live) view.value = value;
      },
      () => {
        if (live) onLegacy();
      },
    );
    return () => {
      live = false;
    };
  }, [artifact.id, version]);

  const refreshState = () =>
    api<BoardState>(`${base}/board`).then(
      (value) => {
        state.value = value;
      },
      () => {
        state.value = null;
      },
    );
  const wiki = artifact.projectKind === "wiki";
  useEffect(() => {
    if (wiki) refreshState();
  }, [artifact.id, version]);
  useEvents(wiki ? artifact.id : undefined, refreshState);

  const snapshot: BoardSnapshot | null = view.value?.snapshot ?? null;
  const scene = useMemo(() => sceneOf(snapshot ?? { objects: [] }), [snapshot]);
  const author = useMemo(() => authorLookup(view.value?.authors ?? []), [view.value]);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    if (!root.current || !world.current || !overlay.current || !snapshot) return;
    const look = {
      assetUrl: (hash: string) => assetUrl(artifact.id, hash, version),
      renderUrl: (hash: string) => renderUrl(artifact.id, hash),
      author,
      eye: eye.value,
    };
    const instance = new CanvasEngine(root.current, world.current, overlay.current, [], [], {
      renderUrl: look.renderUrl,
      onTap(_frame, at) {
        const hit = hitTest(sceneRef.current, at, 6 / instance.s);
        if (commenting.value && hit) {
          const pose = worldPose(sceneRef.current, hit.id) ?? hit.pose;
          const { u, v } = localUV(pose, at);
          const cu = Math.min(1, Math.max(0, u));
          const cv = Math.min(1, Math.max(0, v));
          commenting.value = false;
          draft.value = {
            pageKey: page.key,
            anchor: { type: "object", object: hit.id, u: cu, v: cv, checkpoint: version } as never,
            where: objectName(hit),
            pin: { id: "draft", n: 0, frameKey: "", x: 0, y: 0, draft: true, world: at },
          };
          instance.showPoint(at.x, at.y, Math.max(120, (root.current?.clientHeight ?? 600) * 0.3));
          return;
        }
        selected.value = hit?.id ?? null;
      },
      onPin(pin) {
        if (!pin.draft) openId.value = pin.id;
      },
      onFocus() {},
      native: {
        bounds: () => sceneBounds(sceneRef.current),
        onView: () => {
          const box = root.current;
          if (box)
            layer.current?.detail(sceneRef.current, {
              x: instance.x,
              y: instance.y,
              s: instance.s,
              width: box.clientWidth,
              height: box.clientHeight,
            });
        },
      },
    });
    const drawn = new BoardLayer(world.current, look);
    layer.current = drawn;
    drawn.draw(scene);
    engine.current = instance;
    instance.fitAll();
    const onKey = (event: KeyboardEvent) => {
      const command = canvasCommand(event);
      if (command === "fit") instance.fitAll(true);
      if (command === "actual") instance.zoomTo(1);
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      drawn.destroy();
      instance.destroy();
      engine.current = null;
      layer.current = null;
    };
  }, [snapshot]);

  useEffect(() => {
    layer.current?.setLook({ eye: eye.value });
    layer.current?.draw(scene);
  }, [eye.value]);

  useEffect(() => {
    root.current?.classList.toggle("commenting", commenting.value);
  }, [commenting.value]);

  const review = useReview<Draft & { pin: Pin }>({
    artifact,
    page: page.key,
    version,
    threads,
    openPosted: true,
    where: (thread) => {
      const anchor = objectAnchor(thread);
      const object = anchor && scene.objects.get(anchor.object);
      return object ? objectName(object) : (page.title ?? page.key);
    },
    onShow(thread) {
      const anchor = objectAnchor(thread);
      const object = anchor && scene.objects.get(anchor.object);
      if (object && thread.anchorState !== "orphaned") engine.current?.focusRect(objectBounds(scene, object));
    },
  });
  const { all, draft, openId, listOpen } = review;

  // Pins follow their object: placed from its pose in this checkpoint, never from a picture.
  const pins: Pin[] = all.flatMap((thread) => {
    const anchor = objectAnchor(thread);
    if (!anchor || thread.anchorState === "orphaned") return [];
    const at = anchorPoint(scene, anchor.object, anchor.u, anchor.v);
    const object = scene.objects.get(anchor.object);
    if (!at || !object) return [];
    return [
      {
        id: thread.id,
        n: thread.n,
        frameKey: "",
        x: anchor.u,
        y: anchor.v,
        world: at,
        label: objectName(object),
        done: thread.status === "resolved",
        active: thread.id === openId.value,
      },
    ];
  });
  useEffect(() => {
    engine.current?.setPins(draft.value ? [...pins, draft.value.pin] : pins);
  });

  const board = state.value;
  const canEdit = !!board?.canEdit && board.editable && latest;
  const canAsk = !!board?.editable && !board.canEdit && latest && !!me.value && artifact.permissions.comment;
  const canComment = artifact.permissions.comment && latest;

  const startEdit = () => {
    if (editor.value) {
      editing.value = true;
      return;
    }
    opening.value = true;
    import("./editor.tsx").then(
      (module) => {
        editor.value = module.BoardEditor;
        editing.value = true;
        opening.value = false;
      },
      () => {
        opening.value = false;
      },
    );
  };
  useEffect(() => {
    if (canEdit && query.edit === "1" && !editing.value) startEdit();
  }, [canEdit]);

  const Editor = editor.value;
  if (editing.value && Editor && board && view.value)
    return (
      <Editor
        artifact={artifact}
        pageKey={page.key}
        state={board}
        version={version}
        snapshot={view.value.snapshot}
        authors={view.value.authors}
        onClose={() => {
          editing.value = false;
          refreshState();
        }}
      />
    );

  const agents = (view.value?.authors ?? []).filter((a) => a.kind === "agent");
  return (
    <div class="on-canvas on-board has-panel">
      <div
        class="cv board"
        ref={root}
        role="application"
        aria-label={`${page.title ?? page.key} board`}
        aria-describedby="board-keys"
      >
        <div class="world" ref={world} />
        <div class="overlay" ref={overlay} />
      </div>
      <p id="board-keys" class="sr">
        Drag or use two fingers to move around. 0 fits the board, 1 shows it at actual size. The Objects list
        has everything on this board.
      </p>
      <PageCapsule
        title={page.title ?? artifact.title}
        subtitle={
          agents.length
            ? `${artifact.title} · ✎ ${agents.map((a) => a.agent ?? a.name).join(", ")}`
            : artifact.title
        }
        version={version}
        onPages={onPages}
        onVersions={onVersions}
      />
      {canAsk && (
        <div class="board-line" role="note">
          <Eye />
          <span>You can read and comment. Editing this board is for people with Can edit.</span>
        </div>
      )}
      <div class={`board-bar${draft.value ? " hidden" : ""}`} role="toolbar" aria-label="Board">
        <button type="button" class="vb" onClick={() => engine.current?.fitAll(true)}>
          <Maximize />
          Fit
        </button>
        <button
          type="button"
          class="vb"
          onClick={() => {
            outline.value = true;
          }}
        >
          <List />
          Objects
        </button>
        <button
          type="button"
          class="vb"
          aria-pressed={eye.value}
          aria-label="Show who made each object"
          onClick={() => {
            eye.value = !eye.value;
          }}
        >
          <Eye />
          Who
        </button>
        {canComment && (
          <button
            type="button"
            class="vb"
            aria-pressed={commenting.value}
            onClick={() => {
              if (review.openCount > 0 && !commenting.value) listOpen.value = true;
              else commenting.value = !commenting.value;
            }}
          >
            <MessageCircle />
            Comments
            {review.openCount > 0 && <b class="count">{review.openCount}</b>}
          </button>
        )}
        {canEdit ? (
          <button type="button" class="btn mark edit-key" onClick={startEdit} disabled={opening.value}>
            <Pencil />
            {opening.value ? "Opening" : "Edit"}
          </button>
        ) : canAsk ? (
          <button
            type="button"
            class="btn soft edit-key"
            onClick={() => {
              draft.value = {
                pageKey: page.key,
                anchor: null,
                where: page.title ?? page.key,
                pin: { id: "draft", n: 0, frameKey: "", x: 0, y: 0, draft: true },
              };
            }}
          >
            Ask to edit
          </button>
        ) : null}
      </div>
      {commenting.value && <div class="hint glass">Tap an object to comment</div>}
      {review.sheets}
      {outline.value && (
        <Outline
          scene={scene}
          author={author}
          selected={selected.value}
          onPick={(id) => {
            outline.value = false;
            selected.value = id;
            const object = scene.objects.get(id);
            if (object) engine.current?.focusRect(objectBounds(scene, object));
          }}
          onClose={() => {
            outline.value = false;
          }}
        />
      )}
    </div>
  );
}
