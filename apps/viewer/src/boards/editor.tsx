import "../editing/editor.css";
import "./editor.css";
import type { Artifact, Author, CheckpointResult, EditMode, Run, SyncControl } from "@artifacts/schema";
import type {
  BoardCapture,
  BoardObject,
  BoardPose,
  BoardRead,
  BoardSnapshot,
  BoardState,
  BoardSuggestion,
  BoardSuggestionPreview,
} from "@artifacts/schema/boards";
import { useSignal } from "@preact/signals";
import {
  ArrowUpRight,
  BringToFront,
  Check,
  Copy,
  Ellipsis,
  Eraser,
  Eye,
  Frame,
  Image as ImageIcon,
  List,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  SendToBack,
  Shapes,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { ApiFailure, api, message, post } from "../api.ts";
import { CanvasEngine } from "../canvas/engine.ts";
import { Avatar } from "../components/cards.tsx";
import { Sheet } from "../components/sheet.tsx";
import type { Hello, Status } from "../editing/sync.ts";
import { agentShort, plural } from "../format.ts";
import { renderUrl } from "../paths.ts";
import { me } from "../session.ts";
import { capturePictures, uploadImages } from "./capture.ts";
import {
  DOTS,
  hitTest,
  objectBounds,
  objectName,
  type Point,
  pointsBounds,
  posePoint,
  type Scene,
  sceneBounds,
  sceneOf,
  snapDot,
  worldPose,
} from "./geometry.ts";
import { type Action, Arbiter, type Input, type PointerKind, type Route } from "./gestures.ts";
import { BoardWriter, yToBoard } from "./model.ts";
import { Outline } from "./outline.tsx";
import { assetUrl, authorLookup } from "./reader.tsx";
import { BoardLayer, strokePath } from "./render.ts";
import { connect } from "./sync.ts";

type Provider = ReturnType<typeof connect>;

/**
 * The board editor (14, "Viewer, gestures and accessibility"; the hosted design's phone, desktop and
 * iPad frames). A lazy chunk: Yjs, the sync provider and the tools load only on Edit. One tool strip
 * (Select, Pen, Sticky, Shape, Text, Arrow, More); the current tool is yellow. Every change goes
 * through the board model's stamped registers, so pointer, keyboard and outline edits share undo,
 * attribution and holds.
 */

export type EditorProps = {
  artifact: Artifact;
  pageKey: string;
  state: BoardState;
  version: number;
  snapshot: BoardSnapshot;
  authors: Author[];
  onClose(): void;
};

type Tool = "select" | "pen" | "sticky" | "shape" | "text" | "arrow" | "eraser";
type ShapeKind = "rect" | "ellipse" | "diamond" | "line";
type Gesture =
  | { t: "move"; ids: string[]; from: Point; poses: Map<string, BoardPose>; moved: boolean; hit: string }
  | { t: "resize"; id: string; corner: number; pose: BoardPose }
  | { t: "end"; id: string; which: "start" | "end"; at: Point }
  | { t: "arrow"; from: Point; at: Point }
  | { t: "place"; at: Point }
  | { t: "erase" };

const AGENT = "Claude";
const MODES: { mode: EditMode; word: string; says: string }[] = [
  { mode: "write", word: "Write", says: `You draw. ${AGENT} stays out.` },
  {
    mode: "pair",
    word: "Pair",
    says: `${AGENT} suggests beside you, as see-through objects. You accept or reject.`,
  },
  { mode: "delegate", word: "Delegate", says: "Say what you want and leave. Review a checkpoint after." },
];
const TOOLS: { tool: Tool; word: string; icon: preact.ComponentType }[] = [
  { tool: "select", word: "Select", icon: MousePointer2 },
  { tool: "pen", word: "Pen", icon: Pencil },
  { tool: "sticky", word: "Sticky", icon: StickyNote },
  { tool: "shape", word: "Shape", icon: Shapes },
  { tool: "text", word: "Text", icon: Type },
  { tool: "arrow", word: "Arrow", icon: ArrowUpRight },
];
const INKS = [
  { color: "#242424", word: "Black" },
  { color: "#d64532", word: "Red" },
  { color: "#1f9d55", word: "Green" },
  { color: "#e3b10b", word: "Yellow" },
];
const WIDTHS = [
  { width: 2, word: "Thin" },
  { width: 4, word: "Medium" },
  { width: 8, word: "Thick" },
];
const FILLS = ["#fff2a8", "#d9ead3", "#f8d6c8", "#d6e6f5", "#ffffff"];
const SHAPES: { shape: ShapeKind; word: string }[] = [
  { shape: "rect", word: "Rectangle" },
  { shape: "ellipse", word: "Ellipse" },
  { shape: "diamond", word: "Diamond" },
  { shape: "line", word: "Line" },
];
const CORNERS: [number, number, string][] = [
  [0, 0, "top left"],
  [1, 0, "top right"],
  [1, 1, "bottom right"],
  [0, 1, "bottom left"],
];
const STROKE_MAX = 2048;
const storedKey = (artifactId: string) => `artifacts.edit.${artifactId}.author`;

const inputOf = (event: PointerEvent): Input => ({
  id: event.pointerId,
  type: (["pen", "touch"].includes(event.pointerType) ? event.pointerType : "mouse") as PointerKind,
  x: event.clientX,
  y: event.clientY,
  t: event.timeStamp,
});

/** The same scene with some objects' poses replaced: a drag's preview, never written until it ends. */
function withPoses(scene: Scene, poses: Map<string, BoardPose>): Scene {
  if (poses.size === 0) return scene;
  return sceneOf({
    objects: scene.order.map((o) => (poses.has(o.id) ? { ...o, pose: poses.get(o.id) as BoardPose } : o)),
  });
}

/** Down to the stroke limit, keeping both ends (14, "Assets and limits"). */
function simplify(points: { x: number; y: number; p: number }[]) {
  let out = points;
  while (out.length > STROKE_MAX) out = out.filter((_, i) => i % 2 === 0 || i === out.length - 1);
  return out;
}

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

export function BoardEditor({
  artifact,
  pageKey,
  state: initial,
  version,
  snapshot,
  authors: initialAuthors,
  onClose,
}: EditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const chrome = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const engine = useRef<CanvasEngine | null>(null);
  const writer = useRef<BoardWriter | null>(null);
  const undo = useRef<BoardWriter["undo"] | null>(null);
  const provider = useRef<Provider | null>(null);
  const awareness = useRef<Awareness | null>(null);
  const sceneRef = useRef<Scene>(sceneOf(snapshot));
  const ghostRef = useRef<Scene>(sceneOf({ objects: [] }));
  const redrawRef = useRef<() => void>(() => {});
  const authorRef = useRef<string | null>(null);
  const handoff = useRef<Promise<unknown> | null>(null);

  const doc = useSignal<BoardState>(initial);
  const mode = useSignal<EditMode>("write");
  const status = useSignal<Status>("connecting");
  const hello = useSignal<Hello | null>(null);
  const ready = useSignal(false);
  const tool = useSignal<Tool>("select");
  const shape = useSignal<ShapeKind>("rect");
  const ink = useSignal({ color: "#242424", width: 4 });
  const pencilDraws = useSignal(true);
  const selected = useSignal<string[]>([]);
  const editingText = useSignal<string | null>(null);
  const eye = useSignal(false);
  const sheet = useSignal<null | "more" | "save" | "delegate" | "modes" | "outline">(null);
  const notice = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const others = useSignal<{ name: string; kind: string }[]>([]);
  const authors = useSignal<Author[]>(initialAuthors);
  const suggestions = useSignal<BoardSuggestion[]>([]);
  const previews = useSignal<Map<string, BoardSuggestionPreview>>(new Map());
  const current = useSignal(0);
  const tick = useSignal(0);
  const reviewDismissed = useSignal<string | null>(null);

  const base = `/api/artifacts/${artifact.id}`;
  const say = (text: string) => {
    if (live.current) live.current.textContent = text;
  };
  const author = authorLookup([
    ...authors.value,
    ...(hello.value
      ? [
          {
            key: hello.value.author,
            kind: "person" as const,
            name: me.value?.name ?? "You",
            agent: null,
            for: null,
            sources: [],
          },
        ]
      : []),
  ]);

  const refreshDoc = () =>
    api<BoardState>(`${base}/board`).then(
      (value) => {
        doc.value = value;
      },
      () => {},
    );
  const refreshAuthors = () =>
    api<BoardRead>(`${base}/board/objects?draft=1`).then(
      (value) => {
        const known = new Map(authors.value.map((a) => [a.key, a]));
        for (const a of value.authors) known.set(a.key, a);
        authors.value = [...known.values()];
      },
      () => {},
    );
  /** Open suggestions, each drawn as ghosts from its server preview (all pages). */
  const refreshSuggestions = async () => {
    try {
      const list = await api<{ suggestions: BoardSuggestion[] }>(`${base}/board/suggestions?status=open`);
      const next = new Map<string, BoardSuggestionPreview>();
      for (const suggestion of list.suggestions) {
        let cursor: string | null = "";
        let merged: BoardSuggestionPreview | null = null;
        while (cursor !== null) {
          const page: BoardSuggestionPreview = await api<BoardSuggestionPreview>(
            `/api/board-suggestions/${suggestion.id}/preview${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          merged = merged
            ? {
                ...page,
                objects: [...merged.objects, ...page.objects],
                deleted: [...merged.deleted, ...page.deleted],
              }
            : page;
          cursor = page.nextCursor;
        }
        if (merged) next.set(suggestion.id, merged);
      }
      const before = new Set(suggestions.value.map((s) => s.id));
      const fresh = list.suggestions.find((s) => !before.has(s.id));
      if (fresh) say(`${agentShort(fresh.author.agent ?? fresh.author.name)} suggests a change`);
      suggestions.value = list.suggestions;
      previews.value = next;
      current.value = Math.min(current.value, Math.max(0, list.suggestions.length - 1));
      redrawRef.current();
    } catch {}
  };

  const decide = (id: string, verb: "accept" | "reject") =>
    post(`/api/board-suggestions/${id}/${verb}`, {}).then(
      () => {
        suggestions.value = suggestions.value.filter((s) => s.id !== id);
        const next = new Map(previews.value);
        next.delete(id);
        previews.value = next;
        notice.value = verb === "accept" ? "Accepted" : "Rejected";
        // The card's button can go with the card: keep the keyboard on the board.
        if (document.activeElement === document.body) root.current?.focus();
        redrawRef.current();
        refreshAuthors();
      },
      (failure) => {
        error.value = message(failure);
        refreshSuggestions();
      },
    );

  const setHold = (ids: string[]) => {
    // Advertised before the first mutation and kept while selected or edited (14, "Sync and holds").
    awareness.current?.setLocalStateField("objects", ids.slice(0, 50));
  };

  // The document, its sync, the engine and the gestures: made once per open editor.
  useLayoutEffect(() => {
    if (!root.current || !world.current || !overlay.current) return;
    let destroyed = false;
    let frame = 0;
    const ydoc = new Y.Doc();
    const people = new Awareness(ydoc);
    awareness.current = people;
    authorRef.current = localStorage.getItem(storedKey(artifact.id));
    people.setLocalState({
      user: {
        author: authorRef.current ?? "",
        name: me.value?.name ?? "You",
        kind: "person",
        color: "#ffd84d",
      },
      mode: mode.value,
      objects: [],
      pending: [],
      cursor: null,
    });
    const board = new BoardWriter(ydoc, () => (ready.value && hello.value ? authorRef.current : null));
    writer.current = board;
    const history = board.undo;
    undo.current = history;
    let gesture: Gesture | null = null;
    let preview = new Map<string, BoardPose>();
    let stroke: {
      points: { x: number; y: number; p: number }[];
      path: SVGPathElement;
      svg: SVGSVGElement;
    } | null = null;
    let arrowPreview: SVGSVGElement | null = null;
    let spaceDown = false;
    const look = {
      assetUrl: (hash: string) => assetUrl(artifact.id, hash),
      renderUrl: (hash: string) => renderUrl(artifact.id, hash),
      author: (key: string) => authorLookupRef.current(key),
      eye: eye.value,
    };
    const layer = new BoardLayer(world.current, look);
    const ghosts = new BoardLayer(world.current, look, "ghosts");
    const tags = document.createElement("div");
    tags.className = "blayer";
    world.current.append(tags);

    const read = () => {
      sceneRef.current = ready.value ? sceneOf(yToBoard(ydoc)) : sceneOf(snapshot);
    };
    const draw = () => {
      frame = 0;
      if (destroyed) return;
      const scene = withPoses(sceneRef.current, preview);
      const marks = new Map<string, string>();
      const ghostObjects: BoardObject[] = [];
      tags.replaceChildren();
      for (const [id, p] of previews.value) {
        for (const id2 of p.deleted) marks.set(id2, "proposed-delete");
        const suggestion = suggestions.value.find((s) => s.id === id);
        for (const { object } of p.objects) {
          ghostObjects.push(object);
          const tag = document.createElement("div");
          tag.className = "ghost-tag";
          tag.textContent = `✎ ${agentShort(suggestion?.author.agent ?? AGENT)} suggests`;
          tag.style.left = `${object.pose.x}px`;
          tag.style.top = `${object.pose.y}px`;
          tags.append(tag);
        }
      }
      for (const id of reviewIds.current) marks.set(id, "review-changed");
      layer.setLook({ eye: eye.value });
      ghosts.setLook({ eye: false });
      layer.draw(scene, marks);
      // Ghosts resolve their bound ends against the board plus themselves, but never hit-test as objects.
      const ghostScene = sceneOf({
        objects: [...scene.order.filter((o) => !ghostObjects.some((g) => g.id === o.id)), ...ghostObjects],
      });
      ghostRef.current = sceneOf({ objects: ghostObjects });
      ghosts.draw({
        objects: ghostScene.objects,
        order: ghostScene.order.filter((o) => ghostObjects.some((g) => g.id === o.id)),
      });
      placeChrome();
      const box = root.current;
      if (box)
        layer.detail(scene, {
          x: instance.x,
          y: instance.y,
          s: instance.s,
          width: box.clientWidth,
          height: box.clientHeight,
        });
    };
    const schedule = () => {
      if (!frame && !destroyed) frame = requestAnimationFrame(draw);
    };
    redrawRef.current = () => {
      read();
      schedule();
      tick.value++;
    };
    const onUpdate = () => {
      read();
      schedule();
      tick.value++;
    };
    ydoc.on("update", onUpdate);

    /** Selection chrome in screen space: a box, 14pt handles with 44pt grabs, the context bar. */
    const placeChrome = () => {
      const box = chrome.current;
      if (!box || destroyed) return;
      const scene = withPoses(sceneRef.current, preview);
      const ids = selected.value.filter((id) => scene.objects.has(id));
      const selection = box.querySelector<HTMLElement>(".selbox");
      const bar = box.querySelector<HTMLElement>(".ctx");
      const handles = [...box.querySelectorAll<HTMLElement>(".hd")];
      if (ids.length === 0 || !selection || !bar) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const one = ids.length === 1 ? (scene.objects.get(ids[0] as string) as BoardObject) : null;
      const rect = pointsBounds(
        ids.flatMap((id) => {
          const b = objectBounds(scene, scene.objects.get(id) as BoardObject);
          return [
            { x: b.x, y: b.y },
            { x: b.x + b.w, y: b.y + b.h },
          ];
        }),
      );
      const tl = instance.toScreen(rect.x, rect.y);
      const br = instance.toScreen(rect.x + rect.w, rect.y + rect.h);
      Object.assign(selection.style, {
        left: `${tl.x}px`,
        top: `${tl.y}px`,
        width: `${br.x - tl.x}px`,
        height: `${br.y - tl.y}px`,
      });
      const barWidth = bar.offsetWidth || 260;
      const width = root.current?.clientWidth ?? 390;
      bar.style.left = `${Math.max(8, Math.min(width - barWidth - 8, (tl.x + br.x) / 2 - barWidth / 2))}px`;
      bar.style.top = `${Math.max(64, tl.y - 68)}px`;
      const corners: (Point | null)[] =
        one?.kind === "connector"
          ? [
              ...(() => {
                const ends = [one.data.start, one.data.end].map((end) => {
                  if (end.binding) {
                    const pose = worldPose(scene, end.binding.object);
                    if (pose) return posePoint(pose, end.binding.u, end.binding.v);
                  }
                  return end.point;
                });
                return ends;
              })(),
              null,
              null,
            ]
          : one && one.kind !== "rendered_frame"
            ? CORNERS.map(([u, v]) => posePoint(worldPose(scene, one.id) ?? one.pose, u, v))
            : one
              ? CORNERS.map(([u, v]) => posePoint(worldPose(scene, one.id) ?? one.pose, u, v))
              : [null, null, null, null];
      handles.forEach((handle, i) => {
        const at = corners[i];
        handle.hidden = !at;
        if (at) {
          const p = instance.toScreen(at.x, at.y);
          handle.style.transform = `translate(${p.x}px, ${p.y}px)`;
        }
      });
    };

    const hitAt = (p: Point) => hitTest(sceneRef.current, p, 8 / instance.s);
    const ghostAt = (p: Point) => hitTest(ghostRef.current, p, 8 / instance.s);
    const lastEvent = new Map<number, PointerEvent>();
    const worldOf = (p: Input) => {
      const box = root.current?.getBoundingClientRect();
      return {
        x: (p.x - (box?.left ?? 0) - instance.x) / instance.s,
        y: (p.y - (box?.top ?? 0) - instance.y) / instance.s,
      };
    };

    /** Drawing during a Delegate run takes the pen back: Write, and the run is cancelled first. */
    const takePen = () => {
      const run = doc.value.runs.find((r) => r.status === "active");
      if (!run || handoff.current) return;
      mode.value = "write";
      people.setLocalStateField("mode", "write");
      provider.current?.send({ t: "mode", mode: "write" });
      say("You have the pen. Write mode.");
      handoff.current = post(`/api/runs/${run.id}/cancel`, {}).then(
        () => {
          handoff.current = null;
          refreshDoc();
        },
        (failure) => {
          handoff.current = null;
          error.value = `${message(failure)} Your drawing is kept here.`;
        },
      );
    };

    const route = (p: Input): Route => {
      if (!ready.value || spaceDown) return "nav";
      const target = lastEvent.get(p.id)?.target as HTMLElement | null;
      if (target?.closest?.(".hd")) return "tool";
      if (p.type === "pen" && pencilDraws.value) return tool.value === "eraser" ? "tool" : "ink";
      if (tool.value === "pen") return "ink";
      if (tool.value !== "select") return "tool";
      const at = worldOf(p);
      return hitAt(at) || ghostAt(at) ? "tool" : "nav";
    };
    const arbiter = new Arbiter(route);

    const nav = (p: Input) => ({
      pointerId: p.id,
      clientX: p.x,
      clientY: p.y,
      timeStamp: p.t,
      target: root.current as EventTarget,
    });

    const startInk = (p: Input) => {
      takePen();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "ink-live");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", ink.value.color);
      path.setAttribute("stroke-width", String(ink.value.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
      world.current?.append(svg);
      const at = worldOf(p);
      const pressure = lastEvent.get(p.id)?.pressure || 0.5;
      stroke = { points: [{ ...at, p: pressure }], path, svg };
      path.setAttribute("d", strokePath(stroke.points));
    };
    const extendInk = (p: Input) => {
      if (!stroke) return;
      const event = lastEvent.get(p.id);
      const samples = event?.getCoalescedEvents?.().length ? event.getCoalescedEvents() : [event];
      for (const sample of samples) {
        if (!sample) continue;
        const at = worldOf({ ...p, x: sample.clientX, y: sample.clientY });
        const last = stroke.points.at(-1);
        if (last && Math.hypot(at.x - last.x, at.y - last.y) < 0.75 / instance.s) continue;
        stroke.points.push({ ...at, p: sample.pressure || 0.5 });
      }
      stroke.path.setAttribute("d", strokePath(stroke.points));
    };
    const dropInk = () => {
      stroke?.svg.remove();
      stroke = null;
    };
    const commitInk = async () => {
      const done = stroke;
      if (!done) return;
      stroke = null;
      // A tap with the pen leaves no stray dot.
      if (done.points.length < 2) return done.svg.remove();
      if (handoff.current) await handoff.current.catch(() => {});
      if (destroyed) return;
      const width = ink.value.width;
      const points = simplify(done.points);
      const box = pointsBounds(points);
      const pad = width / 2;
      const pose = {
        x: box.x - pad,
        y: box.y - pad,
        w: Math.max(1, box.w + pad * 2),
        h: Math.max(1, box.h + pad * 2),
        angle: 0,
      };
      board.transact(() =>
        board.add(
          {
            kind: "stroke",
            points: points.map((q) => ({
              u: Math.min(1, Math.max(0, (q.x - pose.x) / pose.w)),
              v: Math.min(1, Math.max(0, (q.y - pose.y) / pose.h)),
              pressure: Math.min(1, Math.max(0, q.p)),
            })),
          },
          pose,
          { style: { stroke: ink.value.color, strokeWidth: width } },
        ),
      );
      done.svg.remove();
    };

    const select = (ids: string[]) => {
      selected.value = ids;
      setHold(ids);
      placeChrome();
    };

    const startTool = (p: Input) => {
      const at = worldOf(p);
      const target = lastEvent.get(p.id)?.target as HTMLElement | null;
      const handle = target?.closest?.<HTMLElement>(".hd");
      if (tool.value !== "select" || handle) takePen();
      if (handle) {
        const id = selected.value[0];
        const object = id ? sceneRef.current.objects.get(id) : null;
        const index = Number(handle.dataset.i);
        if (object?.kind === "connector")
          gesture = { t: "end", id: object.id, which: index === 0 ? "start" : "end", at };
        else if (object) gesture = { t: "resize", id: object.id, corner: index, pose: object.pose };
        return;
      }
      if (tool.value === "eraser") {
        gesture = { t: "erase" };
        return eraseAt(at);
      }
      if (tool.value === "arrow") {
        gesture = { t: "arrow", from: at, at };
        return;
      }
      if (tool.value !== "select") {
        gesture = { t: "place", at };
        return;
      }
      const ghost = ghostAt(at);
      if (ghost) {
        const index = suggestions.value.findIndex((s) =>
          previews.value.get(s.id)?.objects.some((o) => o.object.id === ghost.id),
        );
        if (index >= 0) current.value = index;
        return;
      }
      const hit = hitAt(at);
      if (!hit) return;
      const shift = lastEvent.get(p.id)?.shiftKey;
      const ids = shift
        ? [...new Set([...selected.value, hit.id])]
        : selected.value.includes(hit.id)
          ? selected.value
          : [hit.id];
      select(ids);
      const movable = ids.filter((id) => sceneRef.current.objects.get(id)?.kind !== "connector");
      gesture = {
        t: "move",
        ids: movable,
        from: at,
        poses: new Map(movable.map((id) => [id, (sceneRef.current.objects.get(id) as BoardObject).pose])),
        moved: false,
        hit: hit.id,
      };
    };

    const eraseAt = (at: Point) => {
      const hit = hitTest(sceneRef.current, at, 10 / instance.s);
      if (hit?.kind === "stroke") {
        board.transact(() => board.remove(hit.id));
        say("Drawing erased");
      }
    };

    const moveTool = (p: Input) => {
      const at = worldOf(p);
      if (!gesture) return;
      if (gesture.t === "erase") return eraseAt(at);
      if (gesture.t === "move") {
        const dx = at.x - gesture.from.x;
        const dy = at.y - gesture.from.y;
        if (!gesture.moved && Math.hypot(dx, dy) * instance.s < 4) return;
        gesture.moved = true;
        preview = new Map(
          [...gesture.poses].map(([id, pose]) => [id, { ...pose, x: pose.x + dx, y: pose.y + dy }]),
        );
        schedule();
      } else if (gesture.t === "resize") {
        const { pose, corner } = gesture;
        const parentPose = (() => {
          const object = sceneRef.current.objects.get(gesture.id);
          const up = object?.parent ? worldPose(sceneRef.current, object.parent) : null;
          return up ?? { x: 0, y: 0 };
        })();
        const local = { x: at.x - parentPose.x, y: at.y - parentPose.y };
        const [cu, cv] = CORNERS[corner] as [number, number, string];
        const left = cu === 0 ? Math.min(local.x, pose.x + pose.w - 8) : pose.x;
        const top = cv === 0 ? Math.min(local.y, pose.y + pose.h - 8) : pose.y;
        const right = cu === 1 ? Math.max(local.x, pose.x + 8) : pose.x + pose.w;
        const bottom = cv === 1 ? Math.max(local.y, pose.y + 8) : pose.y + pose.h;
        preview = new Map([[gesture.id, { ...pose, x: left, y: top, w: right - left, h: bottom - top }]]);
        schedule();
      } else if (gesture.t === "arrow" || gesture.t === "end") {
        gesture.at = at;
        drawArrowPreview();
      }
    };

    const drawArrowPreview = () => {
      if (!gesture || (gesture.t !== "arrow" && gesture.t !== "end")) return;
      const radius = 28 / instance.s;
      let from: Point;
      let to: Point;
      if (gesture.t === "arrow") {
        from = snapDot(sceneRef.current, gesture.from, radius)?.at ?? gesture.from;
        to = snapDot(sceneRef.current, gesture.at, radius)?.at ?? gesture.at;
      } else {
        const object = sceneRef.current.objects.get(gesture.id);
        if (object?.kind !== "connector") return;
        const other = gesture.which === "start" ? object.data.end : object.data.start;
        const fixed = other.binding
          ? posePoint(
              worldPose(sceneRef.current, other.binding.object) ?? object.pose,
              other.binding.u,
              other.binding.v,
            )
          : other.point;
        const moving = snapDot(sceneRef.current, gesture.at, radius)?.at ?? gesture.at;
        [from, to] = gesture.which === "start" ? [moving, fixed] : [fixed, moving];
      }
      if (!arrowPreview) {
        arrowPreview = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        arrowPreview.setAttribute("class", "ink-live");
        world.current?.append(arrowPreview);
      }
      const snapped = snapDot(sceneRef.current, gesture.at, radius);
      const dots = snapped
        ? DOTS.map(([u, v]) => {
            const pose = worldPose(sceneRef.current, snapped.object);
            const at = pose ? posePoint(pose, u, v) : null;
            return at
              ? `<circle cx="${at.x}" cy="${at.y}" r="${6 / instance.s}" fill="#fff" stroke="#2b8cd6" stroke-width="${2 / instance.s}"/>`
              : "";
          }).join("")
        : "";
      // Numbers only: nothing from the board's text reaches this markup.
      arrowPreview.innerHTML = `<path d="M${from.x} ${from.y}L${to.x} ${to.y}" stroke="#242424" stroke-width="2" fill="none"/>${dots}`;
    };

    const endpointAt = (at: Point, skip?: string) => {
      const snap = snapDot(sceneRef.current, at, 28 / instance.s, skip ? new Set([skip]) : undefined);
      return snap
        ? { point: snap.at, binding: { object: snap.object, u: snap.u, v: snap.v } }
        : { point: at, binding: null };
    };

    const endTool = (p: Input) => {
      const at = worldOf(p);
      const done = gesture;
      gesture = null;
      arrowPreview?.remove();
      arrowPreview = null;
      if (!done) return;
      if (done.t === "move") {
        const poses = preview;
        preview = new Map();
        if (!done.moved) {
          // A tap: select, and a second tap on a selected text object edits it.
          schedule();
          return;
        }
        board.transact(() => {
          for (const [id, pose] of poses) board.place(id, pose);
        });
      } else if (done.t === "resize") {
        const pose = preview.get(done.id);
        preview = new Map();
        if (pose) board.transact(() => board.place(done.id, pose));
      } else if (done.t === "end") {
        const object = sceneRef.current.objects.get(done.id);
        if (object?.kind !== "connector") return;
        const end = endpointAt(at, done.id);
        const data = { ...object.data, [done.which]: end };
        board.transact(() => board.setData(done.id, data as never));
      } else if (done.t === "arrow") {
        const start = endpointAt(done.from);
        const end = endpointAt(at);
        if (Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y) * instance.s < 12)
          return schedule();
        const box = pointsBounds([start.point, end.point]);
        let id = "";
        board.transact(() => {
          id = board.add(
            { kind: "connector", data: { start, end, route: "straight", startArrow: false, endArrow: true } },
            { ...box, angle: 0 },
          );
        });
        select([id]);
        say(`Arrow added${end.binding ? ", joined" : ""}`);
      } else if (done.t === "place") {
        const at0 = done.at;
        let id = "";
        board.transact(() => {
          if (tool.value === "sticky")
            id = board.add(
              { kind: "sticky", text: "" },
              { x: at0.x - 80, y: at0.y - 80, w: 160, h: 160, angle: 0 },
            );
          else if (tool.value === "shape")
            id = board.add(
              { kind: "shape", shape: shape.value, text: "" },
              shape.value === "line"
                ? { x: at0.x - 80, y: at0.y, w: 160, h: 1, angle: 0 }
                : { x: at0.x - 80, y: at0.y - 48, w: 160, h: 96, angle: 0 },
            );
          else if (tool.value === "text")
            id = board.add({ kind: "text", text: "" }, { x: at0.x, y: at0.y - 14, w: 240, h: 40, angle: 0 });
        });
        // A single-shot tool goes back to Select: no invisible drawing mode is left behind.
        const kind = tool.value;
        tool.value = "select";
        select([id]);
        say(`${kind === "sticky" ? "Sticky" : kind === "shape" ? "Shape" : "Text"} added`);
        if (kind !== "shape" || shape.value !== "line") editingText.value = id;
      }
      schedule();
    };

    const run = (actions: Action[]) => {
      for (const action of actions) {
        switch (action.t) {
          case "ink-start":
            startInk(action.p);
            break;
          case "ink-move":
            extendInk(action.p);
            break;
          case "ink-end":
            void commitInk();
            break;
          case "ink-cancel":
            dropInk();
            break;
          case "tool-start":
            startTool(action.p);
            break;
          case "tool-move":
            moveTool(action.p);
            break;
          case "tool-end":
            endTool(action.p);
            break;
          case "tool-cancel":
            gesture = null;
            preview = new Map();
            arrowPreview?.remove();
            arrowPreview = null;
            schedule();
            break;
          case "nav-down":
            instance.navDown(nav(action.p));
            break;
          case "nav-move":
            instance.navMove(nav(action.p));
            break;
          case "nav-up":
            instance.navUp(nav(action.p));
            break;
          case "undo":
            doUndo();
            break;
        }
      }
    };

    const instance = new CanvasEngine(root.current, world.current, overlay.current, [], [], {
      renderUrl: look.renderUrl,
      onTap(_frame, at) {
        if (destroyed) return;
        const ghost = ghostAt(at);
        if (ghost) {
          const index = suggestions.value.findIndex((s) =>
            previews.value.get(s.id)?.objects.some((o) => o.object.id === ghost.id),
          );
          if (index >= 0) current.value = index;
          return;
        }
        editingText.value = null;
        select([]);
      },
      onPin() {},
      onFocus() {},
      native: {
        bounds: () => sceneBounds(sceneRef.current, ghostRef.current),
        onView: () => {
          placeChrome();
          if (editingText.value) placeText();
        },
        input: {
          down(event) {
            lastEvent.set(event.pointerId, event);
            try {
              root.current?.setPointerCapture(event.pointerId);
            } catch {} // A synthetic or lost pointer: ownership still comes from the arbiter, not capture.
            run(arbiter.down(inputOf(event)));
            return true;
          },
          move(event) {
            lastEvent.set(event.pointerId, event);
            run(arbiter.move(inputOf(event)));
            return true;
          },
          up(event, cancel) {
            lastEvent.set(event.pointerId, event);
            run(arbiter.up(inputOf(event), cancel));
            lastEvent.delete(event.pointerId);
            return true;
          },
        },
      },
    });
    engine.current = instance;
    instance.fitAll();
    read();
    draw();

    const doUndo = (redo = false) => {
      if (!ready.value) return;
      const result = redo ? history.redo() : history.undo();
      if (!result.done && result.skipped.length === 0)
        return say(redo ? "Nothing to redo" : "Nothing to undo");
      say(result.skipped.length ? "That object changed; undo skipped it" : redo ? "Redone" : "Undone");
    };
    undoRef.current = doUndo;

    const sync = connect(artifact.id, initial.epoch, ydoc, people);
    provider.current = sync;
    const off = [
      sync.on("status", (value) => {
        if (!destroyed) status.value = value;
      }),
      sync.on("hello", (value) => {
        if (destroyed) return;
        hello.value = value;
        authorRef.current = value.author;
        localStorage.setItem(storedKey(artifact.id), value.author);
        people.setLocalStateField("user", {
          author: value.author,
          name: me.value?.name ?? "You",
          kind: "person",
          color: "#ffd84d",
        });
        sync.send({ t: "mode", mode: mode.value });
      }),
      sync.on("synced", () => {
        if (destroyed || ready.value) return;
        ready.value = true;
        read();
        schedule();
      }),
      sync.on("control", (control: SyncControl) => {
        if (destroyed) return;
        if (control.t === "suggestion") refreshSuggestions();
        else if (control.t === "run") {
          refreshDoc();
          refreshAuthors();
          refreshSuggestions();
        } else if (control.t === "checkpoint") {
          refreshDoc();
          refreshAuthors();
          notice.value = `Saved v${control.version}`;
        } else if (control.t === "error") error.value = control.message;
      }),
    ];
    const onPeople = () => {
      const list: { name: string; kind: string }[] = [];
      people.getStates().forEach((value, client) => {
        const user = (value as { user?: { name: string; kind: string } }).user;
        if (client !== ydoc.clientID && user) list.push(user);
      });
      others.value = list;
    };
    people.on("change", onPeople);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " && !typing(event.target)) spaceDown = event.type === "keydown";
      if (event.type !== "keydown" || typing(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        return doUndo(event.shiftKey);
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        return doUndo(true);
      }
      if (mod || event.altKey) return;
      if (event.key === "0") return instance.fitAll(true);
      if (event.key === "1") return instance.zoomTo(1);
      const ids = selected.value.filter((id) => sceneRef.current.objects.has(id));
      if (event.key === "Escape") {
        if (gesture || stroke) {
          gesture = null;
          preview = new Map();
          dropInk();
          schedule();
        } else select([]);
        return;
      }
      if (ids.length === 0 || !ready.value) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        board.transact(() => {
          for (const id of ids) board.remove(id);
        });
        select([]);
        say(ids.length > 1 ? `${ids.length} objects deleted` : "Deleted");
        return;
      }
      if (event.key === "Enter") {
        const object = sceneRef.current.objects.get(ids[0] as string);
        if (object && "text" in object) {
          event.preventDefault();
          editingText.value = object.id;
        }
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      const delta = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[event.key];
      if (delta) {
        event.preventDefault();
        board.transact(() => {
          for (const id of ids) {
            const object = sceneRef.current.objects.get(id);
            if (object && object.kind !== "connector")
              board.place(id, {
                ...object.pose,
                x: object.pose.x + (delta[0] as number),
                y: object.pose.y + (delta[1] as number),
              });
          }
        });
      }
    };
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKey);
    const forget = () => arbiter.reset();
    addEventListener("blur", forget);

    return () => {
      destroyed = true;
      cancelAnimationFrame(frame);
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
      removeEventListener("blur", forget);
      for (const stop of off) stop();
      people.off("change", onPeople);
      ydoc.off("update", onUpdate);
      instance.destroy();
      layer.destroy();
      ghosts.destroy();
      sync.destroy();
      people.destroy();
      history.destroy();
      ydoc.destroy();
      engine.current = null;
      writer.current = null;
    };
  }, [artifact.id]);

  const authorLookupRef = useRef(author);
  authorLookupRef.current = author;
  const undoRef = useRef<(redo?: boolean) => void>(() => {});
  const reviewIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    refreshSuggestions();
    refreshAuthors();
    const timer = setInterval(refreshDoc, 15_000);
    return () => clearInterval(timer);
  }, [artifact.id]);

  useEffect(() => {
    document.documentElement.classList.add("editing");
    return () => document.documentElement.classList.remove("editing");
  }, []);

  useEffect(() => {
    if (!notice.value) return;
    const timer = setTimeout(() => {
      notice.value = null;
    }, 2600);
    return () => clearTimeout(timer);
  }, [notice.value]);

  // Eye, selection and review outlines redraw the board.
  useEffect(() => {
    redrawRef.current();
  }, [eye.value, selected.value, authors.value]);

  // The text field sits over the object being edited: a real browser input, so Scribble and screen
  // readers work. Each keystroke diffs into the object's Y.Text with this connection's stamp.
  const placeText = () => {
    const id = editingText.value;
    const box = textBox.current;
    const instance = engine.current;
    const object = id ? sceneRef.current.objects.get(id) : null;
    if (!box || !instance || !object) return;
    const pose = worldPose(sceneRef.current, object.id) ?? object.pose;
    const p = instance.toScreen(pose.x, pose.y);
    Object.assign(box.style, {
      left: `${p.x}px`,
      top: `${p.y}px`,
      width: `${Math.max(120, pose.w * instance.s)}px`,
      height: `${Math.max(44, pose.h * instance.s)}px`,
      fontSize: `${object.style.fontSize * instance.s}px`,
    });
  };
  useEffect(() => {
    const id = editingText.value;
    const box = textBox.current;
    if (!id || !box) return;
    const object = sceneRef.current.objects.get(id);
    box.value = object && "text" in object ? object.text : "";
    placeText();
    box.focus();
    setHold([id]);
  }, [editingText.value]);

  const state = doc.value;
  const runs = state.runs ?? [];
  const activeRun = runs.find((r) => r.status === "active") ?? null;
  const finished = runs.find((r) => r.status === "finished" && r.id !== reviewDismissed.value) ?? null;
  const agentKeys = new Set(authors.value.filter((a) => a.kind === "agent").map((a) => a.key));
  // What a finished run made or changed: objects with fields an agent stamped since it started.
  reviewIds.current = new Set(
    finished
      ? sceneRef.current.order
          .filter((o) =>
            [o.attribution.created, ...Object.values(o.attribution.fields)].some(
              (s) => s && agentKeys.has(s.a) && s.t >= finished.startedAt,
            ),
          )
          .map((o) => o.id)
      : [],
  );
  const saved = !ready.value
    ? status.value === "offline"
      ? "Offline"
      : "Connecting"
    : status.value === "offline"
      ? "Offline. Your changes will sync."
      : "Saved";
  const one =
    selected.value.length === 1 ? (sceneRef.current.objects.get(selected.value[0] as string) ?? null) : null;
  const pick = (next: EditMode) => {
    mode.value = next;
    awareness.current?.setLocalStateField("mode", next);
    provider.current?.send({ t: "mode", mode: next });
    sheet.value = next === "delegate" && !activeRun ? "delegate" : null;
    if (next === "pair") refreshSuggestions();
    say(`${MODES.find((m) => m.mode === next)?.word} mode`);
  };
  const act = (fn: (board: BoardWriter) => void) => {
    const board = writer.current;
    if (!board?.ready) return;
    board.transact(() => fn(board));
  };
  const ids = selected.value;
  const suggestion = suggestions.value[current.value] ?? null;
  const preview = suggestion ? previews.value.get(suggestion.id) : null;
  const line = state.audience
    ? `${state.audience.label} · ${AGENT}'s drawings ${state.agents?.edits === "direct" ? "apply directly" : "arrive as suggestions"}`
    : null;

  return (
    <div class="ed bed on-canvas on-board">
      <div
        class="cv board"
        ref={root}
        role="application"
        aria-label={`Edit ${artifact.title} board`}
        aria-describedby="bed-keys"
        tabIndex={-1}
        data-tool={tool.value}
        data-ready={ready.value ? "1" : "0"}
      >
        <div class="world" ref={world} />
        <div class="overlay" ref={overlay} />
        <div class="chrome" ref={chrome} hidden>
          <div class="selbox" />
          {[0, 1, 2, 3].map((i) => (
            <button
              type="button"
              key={i}
              class="hd"
              data-i={i}
              aria-label={
                one?.kind === "connector"
                  ? i === 0
                    ? "Move the arrow's start"
                    : "Move the arrow's end"
                  : `Resize from ${CORNERS[i]?.[2]}`
              }
            >
              <i />
            </button>
          ))}
          <div class="ctx no-pan" role="toolbar" aria-label="Selected object">
            {one && (one.kind === "sticky" || one.kind === "shape" || one.kind === "frame") && (
              <button
                type="button"
                class="cb"
                aria-label="Change colour"
                onClick={() => {
                  const now = one.style.fill;
                  const next = FILLS[(FILLS.indexOf(now) + 1) % FILLS.length] as string;
                  act((b) => b.setStyle(one.id, { fill: next }));
                }}
              >
                <span
                  class="swatch"
                  style={{ background: one.style.fill === "transparent" ? "#fff" : one.style.fill }}
                />
              </button>
            )}
            {one && "text" in one && (
              <button
                type="button"
                class="cb"
                aria-label="Edit text"
                onClick={() => (editingText.value = one.id)}
              >
                <Type />
              </button>
            )}
            <button
              type="button"
              class="cb"
              aria-label="Duplicate"
              onClick={() =>
                act((b) => {
                  const fresh: string[] = [];
                  for (const id of ids) {
                    const o = sceneRef.current.objects.get(id);
                    if (!o || o.kind === "connector" || o.kind === "rendered_frame") continue;
                    const {
                      id: _id,
                      pose,
                      parent,
                      order: _o,
                      attribution: _a,
                      style,
                      label,
                      ...rest
                    } = o as BoardObject & Record<string, unknown>;
                    fresh.push(
                      b.add(
                        rest as never,
                        { ...pose, x: pose.x + 24, y: pose.y + 24 },
                        { parent, style, label },
                      ),
                    );
                  }
                  if (fresh.length) selected.value = fresh;
                })
              }
            >
              <Copy />
            </button>
            <button
              type="button"
              class="cb"
              aria-label="Bring to front"
              onClick={() =>
                act((b) => {
                  for (const id of ids) b.reorder(id, "front");
                })
              }
            >
              <BringToFront />
            </button>
            <button
              type="button"
              class="cb"
              aria-label="Send to back"
              onClick={() =>
                act((b) => {
                  for (const id of ids) b.reorder(id, "back");
                })
              }
            >
              <SendToBack />
            </button>
            <button
              type="button"
              class="cb"
              aria-label="Delete"
              onClick={() => {
                act((b) => {
                  for (const id of ids) b.remove(id);
                });
                selected.value = [];
                setHold([]);
                root.current?.focus();
                say("Deleted");
              }}
            >
              <Trash2 />
            </button>
          </div>
        </div>
        {editingText.value && (
          <textarea
            ref={textBox}
            class="tedit no-pan"
            aria-label="Text"
            onInput={(event) => {
              const id = editingText.value;
              const value = (event.target as HTMLTextAreaElement).value;
              if (id) writer.current?.setText(id, value);
            }}
            onBlur={() => {
              writer.current?.endText();
              editingText.value = null;
              setHold(selected.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                (event.target as HTMLTextAreaElement).blur();
                root.current?.focus();
              }
            }}
          />
        )}
      </div>
      <p id="bed-keys" class="sr">
        Pick a tool from the toolbar. Arrow keys move the selection by 1 board pixel, with Shift by 10. Delete
        removes it, Enter edits its text, Escape lets go. The Objects list has everything on this board.
      </p>
      <header class="ed-bar bed-bar">
        <button type="button" class="txtbtn" onClick={onClose}>
          Done
        </button>
        <span class="ed-title tag">{artifact.title}</span>
        <div class="ed-modes-wide">
          <Modes mode={mode.value} pick={pick} />
        </div>
        <span class="grow" />
        <ul class="who ed-who" aria-label="Who is here">
          <li>
            <Avatar name={me.value?.name ?? "You"} you />
            <span class="sr">You</span>
          </li>
          {others.value.map((user, index) => (
            <li key={`${user.name}-${index}`}>
              {user.kind === "agent" ? (
                <span class="av agent">
                  <Pencil />
                </span>
              ) : (
                <Avatar name={user.name} />
              )}
              <span class="sr">{user.name}</span>
            </li>
          ))}
        </ul>
        <span class="saved" role="status">
          {saved}
        </span>
        <button
          type="button"
          class={`round${eye.value ? " on" : ""}`}
          aria-label="Show who made each object"
          aria-pressed={eye.value}
          onClick={() => {
            eye.value = !eye.value;
          }}
        >
          <Eye />
        </button>
        <button type="button" class="round" aria-label="More" onClick={() => (sheet.value = "more")}>
          <Ellipsis />
        </button>
      </header>
      <div class="ed-modes-row bed-modes">
        <Modes mode={mode.value} pick={pick} />
        {state.audience && (
          <button type="button" class="aud txtbtn" onClick={() => (sheet.value = "modes")}>
            {state.audience.label}
          </button>
        )}
      </div>
      {activeRun && (
        <div class="lockline" role="status">
          <Pencil />
          {agentShort(activeRun.agent ?? AGENT)} has the pen. Drawing takes it back.
        </div>
      )}
      {tool.value === "pen" && (
        <div class="bed-opts no-pan" role="toolbar" aria-label="Pen">
          {INKS.map((entry) => (
            <button
              type="button"
              key={entry.color}
              class={`cb${ink.value.color === entry.color ? " on" : ""}`}
              aria-label={entry.word}
              aria-pressed={ink.value.color === entry.color}
              onClick={() => (ink.value = { ...ink.value, color: entry.color })}
            >
              <span class="swatch" style={{ background: entry.color }} />
            </button>
          ))}
          <i class="vs" />
          {WIDTHS.map((entry) => (
            <button
              type="button"
              key={entry.width}
              class={`cb${ink.value.width === entry.width ? " on" : ""}`}
              aria-label={entry.word}
              aria-pressed={ink.value.width === entry.width}
              onClick={() => (ink.value = { ...ink.value, width: entry.width })}
            >
              <span class="line" style={{ height: `${entry.width}px` }} />
            </button>
          ))}
        </div>
      )}
      {tool.value === "shape" && (
        <div class="bed-opts no-pan" role="toolbar" aria-label="Shape">
          {SHAPES.map((entry) => (
            <button
              type="button"
              key={entry.shape}
              class={`cb txt${shape.value === entry.shape ? " on" : ""}`}
              aria-pressed={shape.value === entry.shape}
              onClick={() => (shape.value = entry.shape)}
            >
              {entry.word}
            </button>
          ))}
        </div>
      )}
      {tool.value === "pen" && <div class="hint bed-hint">One finger draws. Two fingers move.</div>}
      {suggestion && !finished && (
        <section class="bed-card" aria-label={`${AGENT} suggests`}>
          <div class="bed-card-head">
            <span class="av agent">
              <Pencil />
            </span>
            <b class="agent-word">{agentShort(suggestion.author.agent ?? suggestion.author.name)} suggests</b>
            <span class="grow" />
            <span class="ss">
              {current.value + 1} of {suggestions.value.length}
            </span>
          </div>
          <p class="bed-card-note">
            {suggestion.note ??
              (preview
                ? `${plural(preview.objects.length, "object")}${preview.deleted.length ? `, removes ${preview.deleted.length}` : ""}`
                : "A change to this board")}
          </p>
          {preview && (
            <ul class="sr">
              {preview.objects.map(({ object }) => (
                <li key={object.id}>{objectName(object)}</li>
              ))}
            </ul>
          )}
          <div class="acts">
            <button
              type="button"
              class="btn soft"
              onClick={() => decide(suggestion.id, "reject")}
              disabled={!state.canAccept}
            >
              <X />
              Reject
            </button>
            <button
              type="button"
              class="btn ink"
              onClick={() => decide(suggestion.id, "accept")}
              disabled={!state.canAccept}
            >
              <Check />
              Accept
            </button>
          </div>
        </section>
      )}
      {finished && (
        <RunReview
          run={finished}
          count={reviewIds.current.size}
          base={base}
          onDone={(text) => {
            reviewDismissed.value = finished.id;
            notice.value = text;
            refreshDoc();
            redrawRef.current();
          }}
          onError={(text) => (error.value = text)}
        />
      )}
      <div class="bed-tools" role="toolbar" aria-label="Tools">
        {TOOLS.map((entry) => (
          <button
            type="button"
            key={entry.tool}
            class={`tb${tool.value === entry.tool ? " on" : ""}`}
            aria-label={entry.word}
            aria-pressed={tool.value === entry.tool}
            onClick={() => {
              tool.value = entry.tool;
              if (entry.tool !== "select") {
                selected.value = [];
                setHold([]);
              }
              say(`${entry.word} tool`);
            }}
          >
            <entry.icon />
          </button>
        ))}
        <button
          type="button"
          class={`tb${tool.value === "eraser" ? " on" : ""}`}
          aria-label="More tools"
          onClick={() => (sheet.value = "more")}
        >
          {tool.value === "eraser" ? <Eraser /> : <Plus />}
        </button>
      </div>
      <div ref={live} class="sr" aria-live="polite" />
      {notice.value && (
        <div class="toast" role="status">
          {notice.value}
        </div>
      )}
      {error.value && (
        <div class="toast err-toast" role="alert">
          {error.value}
          <button type="button" class="txtbtn" onClick={() => (error.value = null)}>
            OK
          </button>
        </div>
      )}
      {sheet.value === "more" && (
        <Sheet title="More" onClose={() => (sheet.value = null)}>
          <div class="group">
            <label class="li btn-li">
              <ImageIcon />
              <div class="grow">
                <div class="tt">Image</div>
                <div class="ss">PNG, JPEG or WebP, up to 10 MB</div>
              </div>
              <input
                type="file"
                class="sr"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = (event.target as HTMLInputElement).files?.[0];
                  sheet.value = null;
                  if (file) addImage(file);
                }}
              />
            </label>
            <button
              type="button"
              class="li btn-li"
              onClick={() => {
                sheet.value = null;
                const instance = engine.current;
                const box = root.current;
                if (!instance || !box) return;
                const c = instance.toWorld(
                  box.getBoundingClientRect().left + box.clientWidth / 2,
                  box.getBoundingClientRect().top + box.clientHeight / 2,
                );
                act((b) => {
                  const id = b.add(
                    { kind: "frame" },
                    { x: c.x - 240, y: c.y - 160, w: 480, h: 320, angle: 0 },
                    { label: "Frame" },
                  );
                  selected.value = [id];
                });
              }}
            >
              <Frame />
              <div class="grow">
                <div class="tt">Frame</div>
                <div class="ss">A container to group things in</div>
              </div>
            </button>
            <button
              type="button"
              class="li btn-li"
              aria-pressed={tool.value === "eraser"}
              onClick={() => {
                sheet.value = null;
                tool.value = "eraser";
                say("Eraser: removes whole drawings");
              }}
            >
              <Eraser />
              <div class="grow">
                <div class="tt">Eraser</div>
                <div class="ss">Removes whole drawings</div>
              </div>
            </button>
            <button
              type="button"
              class="li btn-li"
              aria-pressed={pencilDraws.value}
              onClick={() => {
                pencilDraws.value = !pencilDraws.value;
              }}
            >
              <Pencil />
              <div class="grow">
                <div class="tt">Apple Pencil draws</div>
                <div class="ss">
                  {pencilDraws.value
                    ? "On: the Pencil always draws, fingers move"
                    : "Off: the Pencil selects"}
                </div>
              </div>
              {pencilDraws.value && <span class="ck">✓</span>}
            </button>
          </div>
          <div class="group">
            <button type="button" class="li btn-li" onClick={() => (sheet.value = "outline")}>
              <List />
              <div class="grow">
                <div class="tt">Objects</div>
                <div class="ss">Everything on the board, as a list</div>
              </div>
            </button>
            <button type="button" class="li btn-li" onClick={() => (sheet.value = "save")}>
              <Check />
              <div class="grow">
                <div class="tt">Save version</div>
                <div class="ss">Readers see v{state.version} until you do.</div>
              </div>
            </button>
            <button type="button" class="li btn-li" onClick={() => undoRef.current()}>
              <Undo2 />
              <div class="grow">
                <div class="tt">Undo</div>
              </div>
            </button>
            <button type="button" class="li btn-li" onClick={() => undoRef.current(true)}>
              <Redo2 />
              <div class="grow">
                <div class="tt">Redo</div>
              </div>
            </button>
          </div>
        </Sheet>
      )}
      {sheet.value === "outline" && (
        <Outline
          scene={sceneRef.current}
          author={author}
          selected={one?.id ?? null}
          onPick={(id) => {
            selected.value = [id];
            setHold([id]);
            const object = sceneRef.current.objects.get(id);
            if (object) engine.current?.focusRect(objectBounds(sceneRef.current, object));
            redrawRef.current();
          }}
          onClose={() => (sheet.value = null)}
        >
          {one && one.kind !== "connector" && <Inspector object={one} act={act} writer={writer.current} />}
        </Outline>
      )}
      {sheet.value === "modes" && (
        <Sheet title={`How should ${AGENT} help?`} onClose={() => (sheet.value = null)}>
          <div class="group">
            {MODES.map((entry) => (
              <button
                type="button"
                aria-pressed={mode.value === entry.mode}
                class="li btn-li"
                key={entry.mode}
                onClick={() => pick(entry.mode)}
              >
                <div class="grow">
                  <div class="tt">{entry.word}</div>
                  <div class="ss">{entry.says}</div>
                </div>
                {mode.value === entry.mode && <span class="ck">✓</span>}
              </button>
            ))}
          </div>
          {line && <p class="fn">{line}.</p>}
        </Sheet>
      )}
      {sheet.value === "delegate" && (
        <DelegateSheet
          base={base}
          onClose={() => (sheet.value = null)}
          onStarted={() => {
            sheet.value = null;
            refreshDoc();
          }}
        />
      )}
      {sheet.value === "save" && (
        <SaveSheet
          artifact={artifact}
          version={state.version}
          awaitSaved={() => {
            if (!provider.current) throw new Error("The editor is not connected.");
            return provider.current.awaitSaved();
          }}
          onClose={() => (sheet.value = null)}
          onSaved={(result) => {
            sheet.value = null;
            notice.value = result.created ? `Saved v${result.version}` : "Nothing new to save";
            refreshDoc();
          }}
        />
      )}
      <span hidden>
        {pageKey}
        {version}
        {tick.value}
      </span>
    </div>
  );

  async function addImage(file: File) {
    try {
      const bitmap = await createImageBitmap(file);
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const image = {
        hash,
        type: file.type as "image/png",
        bytes: file.size,
        width: bitmap.width,
        height: bitmap.height,
      };
      await uploadImages(artifact.id, [{ image, bytes: file }]);
      const instance = engine.current;
      const box = root.current;
      if (!instance || !box) return;
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
      const r = box.getBoundingClientRect();
      const c = instance.toWorld(r.left + box.clientWidth / 2, r.top + box.clientHeight / 2);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      act((b) => {
        selected.value = [
          b.add(
            { kind: "image", asset: hash, alt: file.name.replace(/\.[a-z0-9]+$/i, "") },
            { x: c.x - w / 2, y: c.y - h / 2, w, h, angle: 0 },
          ),
        ];
      });
    } catch (failure) {
      error.value = message(failure, "That image couldn't be added.");
    }
  }
}

function Modes({ mode, pick }: { mode: EditMode; pick(mode: EditMode): void }) {
  return (
    <div class="ed-modes">
      {MODES.map((entry) => (
        <button
          type="button"
          aria-pressed={mode === entry.mode}
          class={mode === entry.mode ? "on" : ""}
          key={entry.mode}
          onClick={() => pick(entry.mode)}
        >
          {entry.word}
        </button>
      ))}
    </div>
  );
}

/** Labelled inputs for the selected object: move or retype it without a drag (14, "Viewer"). */
function Inspector({
  object,
  act,
  writer,
}: {
  object: BoardObject;
  act(fn: (b: BoardWriter) => void): void;
  writer: BoardWriter | null;
}) {
  const field = (key: "x" | "y" | "w" | "h", word: string) => (
    <label class="bed-field">
      {word}
      <input
        type="number"
        value={Math.round(object.pose[key])}
        onChange={(event) => {
          const value = Number((event.target as HTMLInputElement).value);
          if (Number.isFinite(value))
            act((b) =>
              b.place(object.id, {
                ...object.pose,
                [key]: key === "w" || key === "h" ? Math.max(1, value) : value,
              }),
            );
        }}
      />
    </label>
  );
  return (
    <fieldset class="bed-inspect">
      <legend class="sr">Edit {objectName(object)}</legend>
      {"text" in object && (
        <label class="bed-field wide">
          Text
          <textarea
            value={object.text}
            onChange={(event) => {
              writer?.setText(object.id, (event.target as HTMLTextAreaElement).value);
              writer?.endText();
            }}
          />
        </label>
      )}
      {field("x", "X")}
      {field("y", "Y")}
      {field("w", "Width")}
      {field("h", "Height")}
    </fieldset>
  );
}

/** A finished Delegate run: what it changed, outlined in green on the board; Keep or Revert all. */
function RunReview({
  run,
  count,
  base,
  onDone,
  onError,
}: {
  run: Run;
  count: number;
  base: string;
  onDone(text: string): void;
  onError(text: string): void;
}) {
  const busy = useSignal(false);
  const finish = (verb: "keep" | "revert") => {
    busy.value = true;
    const request =
      run.edits === "suggestion"
        ? post<Run>(`/api/runs/${run.id}/${verb === "keep" ? "accept" : "reject"}`, {})
        : verb === "keep"
          ? Promise.resolve(run)
          : // A direct run already made its version: Revert all is an ordinary restore of the one before.
            post(`${base}/versions/${Math.max(1, (run.version ?? 2) - 1)}/restore`, {});
    request.then(
      () => onDone(verb === "keep" ? `Kept${run.version ? ` as v${run.version}` : ""}` : "Reverted"),
      (failure) => {
        busy.value = false;
        onError(message(failure));
      },
    );
  };
  return (
    <section class="bed-card" aria-label={`${agentShort(run.agent ?? AGENT)} finished`}>
      <div class="bed-card-head">
        <span class="av agent">
          <Pencil />
        </span>
        <span>
          <b class="agent-word">{agentShort(run.agent ?? AGENT)}</b> finished · {plural(count, "object")}{" "}
          changed
          {run.goal ? ` · ${run.goal}` : ""}
        </span>
      </div>
      <div class="acts">
        <button type="button" class="btn soft" disabled={busy.value} onClick={() => finish("revert")}>
          Revert all
        </button>
        <button type="button" class="btn mark" disabled={busy.value} onClick={() => finish("keep")}>
          <Check />
          Keep{run.version ? ` · v${run.version}` : ""}
        </button>
      </div>
    </section>
  );
}

function DelegateSheet({ base, onClose, onStarted }: { base: string; onClose(): void; onStarted(): void }) {
  const goal = useSignal("");
  const busy = useSignal(false);
  const failed = useSignal<string | null>(null);
  return (
    <Sheet title={`What should ${AGENT} do?`} onClose={onClose}>
      <textarea
        class="field bed-goal"
        aria-label="Instructions"
        placeholder="Turn this sketch into phone mocks"
        value={goal.value}
        onInput={(event) => (goal.value = (event.target as HTMLTextAreaElement).value)}
      />
      {failed.value && <p class="err">{failed.value}</p>}
      <button
        type="button"
        class="btn mark"
        disabled={busy.value || !goal.value.trim()}
        onClick={() => {
          busy.value = true;
          post<Run>(`${base}/doc/runs`, { goal: goal.value.trim() }).then(onStarted, (f) => {
            busy.value = false;
            failed.value = f instanceof Error ? f.message : message(f);
          });
        }}
      >
        Start
      </button>
    </Sheet>
  );
}

/**
 * Save version: the server fences the persisted draft, this browser draws that exact snapshot and its
 * open pins, and the checkpoint carries the pictures. If pictures fail, the version still saves and
 * its pictures are pending, never an old image passed off as new.
 */
function SaveSheet({
  awaitSaved,
  artifact,
  version,
  onClose,
  onSaved,
}: {
  artifact: Artifact;
  version: number;
  onClose(): void;
  onSaved(result: CheckpointResult): void;
  awaitSaved(): Promise<void>;
}) {
  const name = useSignal("");
  const busy = useSignal(false);
  const failed = useSignal<string | null>(null);
  const base = `/api/artifacts/${artifact.id}/board`;
  const urls = {
    asset: (hash: string) => assetUrl(artifact.id, hash),
    render: (hash: string) => renderUrl(artifact.id, hash),
  };
  const save = async (): Promise<CheckpointResult> => {
    const body = { name: name.value.trim() || null };
    for (let attempt = 0; attempt < 2; attempt++) {
      await awaitSaved();
      const state = await api<BoardState>(`/api/artifacts/${artifact.id}/board`);
      let capture: { ticket: string; renders: unknown } | undefined;
      try {
        const ticket = await post<BoardCapture>(`${base}/captures`, {
          target: { kind: "draft", epoch: state.epoch, seq: state.seq },
        });
        capture = {
          ticket: ticket.ticket,
          renders: await capturePictures(artifact.id, ticket.snapshot, ticket.threads, urls),
        };
      } catch {
        capture = undefined;
      }
      await awaitSaved();
      try {
        return await post<CheckpointResult>(`${base}/checkpoint`, {
          epoch: state.epoch,
          ...body,
          ...(capture ? { capture } : {}),
        });
      } catch (failure) {
        const stale = failure instanceof ApiFailure && failure.details?.reason === "stale_capture";
        if (!stale || attempt === 1) throw failure;
      }
    }
    throw new Error("unreachable");
  };
  return (
    <Sheet title="Save version" onClose={onClose}>
      <p class="ss">Readers see v{version} until you save. Agents read saved versions.</p>
      <input
        class="field"
        aria-label="Name (optional)"
        placeholder="Name (optional)"
        value={name.value}
        onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
      />
      {failed.value && <p class="err">{failed.value}</p>}
      <button
        type="button"
        class="btn mark"
        disabled={busy.value}
        onClick={() => {
          busy.value = true;
          save().then(onSaved, (f) => {
            busy.value = false;
            failed.value = f instanceof Error ? f.message : message(f);
          });
        }}
      >
        {busy.value ? "Syncing and saving" : "Save version"}
      </button>
    </Sheet>
  );
}
