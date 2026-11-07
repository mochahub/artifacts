import type { BoardObject, BoardPose } from "@artifacts/schema/boards";
import { connectorPath, type Point, poseBounds, type Scene, worldPose } from "./geometry.ts";

/**
 * Draws a board's native objects into the canvas engine's world (14, "Viewer"): one absolutely placed
 * element per object, in parent-tree then (order, id) order, redrawn only when an object changes.
 * Text goes in as text nodes, never HTML. Colours are the object's content, whatever the viewer theme.
 */

export type AuthorInfo = { name: string; kind: "person" | "agent" | "source" };
export type Look = {
  assetUrl(hash: string): string;
  renderUrl(hash: string): string;
  author(key: string): AuthorInfo | null;
  /** Show who made each object: initials for a person, the blue pencil and a name for an agent. */
  eye: boolean;
};

const SVG = "http://www.w3.org/2000/svg";
const MAX_FULL = 40; // As the legacy canvas: decoded full-size mock images at once.

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Who wrote most of an object: its text's longest author run, otherwise whoever created it. */
export function mainAuthor(object: BoardObject): string {
  let best = object.attribution.created.a;
  let most = 0;
  for (const run of object.attribution.text) {
    if (run.e - run.s > most) {
      most = run.e - run.s;
      best = run.a;
    }
  }
  return best;
}

/** Text with the blue-pencil underline on what an agent wrote, which stays even with the eye off. */
function textNode(object: BoardObject & { text: string }, look: Look) {
  const box = document.createElement("div");
  box.className = "tx";
  box.style.fontSize = `${object.style.fontSize}px`;
  box.style.textAlign = object.style.align;
  let at = 0;
  for (const run of object.attribution.text) {
    if (run.s > at) box.append(object.text.slice(at, run.s));
    const piece = object.text.slice(run.s, run.e);
    if (look.author(run.a)?.kind === "agent") {
      const span = document.createElement("span");
      span.className = "pen";
      span.textContent = piece;
      box.append(span);
    } else box.append(piece);
    at = run.e;
  }
  if (at < object.text.length) box.append(object.text.slice(at));
  return box;
}

function arrowHead(at: Point, from: Point, color: string, width: number) {
  const angle = Math.atan2(at.y - from.y, at.x - from.x);
  const size = 8 + width * 2;
  const a = { x: at.x - size * Math.cos(angle - 0.45), y: at.y - size * Math.sin(angle - 0.45) };
  const b = { x: at.x - size * Math.cos(angle + 0.45), y: at.y - size * Math.sin(angle + 0.45) };
  return svg("path", {
    d: `M${a.x} ${a.y}L${at.x} ${at.y}L${b.x} ${b.y}`,
    fill: "none",
    stroke: color,
    "stroke-width": width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
}

/** A freehand stroke as a smooth path through its points (quadratic midpoints). */
export function strokePath(points: Point[]) {
  if (points.length === 0) return "";
  const [first] = points as [Point];
  if (points.length < 3) return `M${first.x} ${first.y}${points.map((p) => `L${p.x} ${p.y}`).join("")}`;
  let d = `M${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i] as Point;
    const q = points[i + 1] as Point;
    d += `Q${p.x} ${p.y} ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }
  const last = points.at(-1) as Point;
  return `${d}L${last.x} ${last.y}`;
}

function shapeSvg(object: Extract<BoardObject, { kind: "shape" }>, pose: BoardPose) {
  const { w, h } = pose;
  const sw = object.style.strokeWidth;
  const paint = {
    fill: object.style.fill === "transparent" ? "none" : object.style.fill,
    stroke: object.style.stroke,
    "stroke-width": sw,
  };
  const root = svg("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, overflow: "visible" });
  const inset = sw / 2;
  if (object.shape === "rect")
    root.append(
      svg("rect", {
        x: inset,
        y: inset,
        width: Math.max(1, w - sw),
        height: Math.max(1, h - sw),
        rx: 10,
        ...paint,
      }),
    );
  else if (object.shape === "ellipse")
    root.append(
      svg("ellipse", {
        cx: w / 2,
        cy: h / 2,
        rx: Math.max(0.5, w / 2 - inset),
        ry: Math.max(0.5, h / 2 - inset),
        ...paint,
      }),
    );
  else if (object.shape === "diamond")
    root.append(
      svg("path", {
        d: `M${w / 2} ${inset}L${w - inset} ${h / 2}L${w / 2} ${h - inset}L${inset} ${h / 2}Z`,
        ...paint,
      }),
    );
  else root.append(svg("path", { d: `M0 0L${w} ${h}`, ...paint, fill: "none", "stroke-linecap": "round" }));
  return root;
}

function place(el: HTMLElement, pose: BoardPose) {
  el.style.left = `${pose.x}px`;
  el.style.top = `${pose.y}px`;
  el.style.width = `${pose.w}px`;
  el.style.height = `${pose.h}px`;
  el.style.transform = pose.angle ? `rotate(${pose.angle}rad)` : "";
}

/** One object's element, built from scratch; the layer rebuilds it when its signature changes. */
export function objectElement(scene: Scene, object: BoardObject, look: Look): HTMLElement {
  const el = document.createElement("div");
  el.className = `bo k-${object.kind}`;
  el.dataset.id = object.id;
  el.dataset.kind = object.kind;
  el.style.opacity = String(object.style.opacity);
  const pose = worldPose(scene, object.id) ?? object.pose;
  switch (object.kind) {
    case "connector": {
      const path = connectorPath(scene, object);
      const pad = 24;
      const box = poseBounds({ ...pointsBox(path), angle: 0 });
      place(el, { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2, angle: 0 });
      const local = path.map((p) => ({ x: p.x - box.x + pad, y: p.y - box.y + pad }));
      const root = svg("svg", { width: box.w + pad * 2, height: box.h + pad * 2, overflow: "visible" });
      const color = object.style.stroke;
      const width = Math.max(1, object.style.strokeWidth);
      root.append(
        svg("path", {
          d: `M${local.map((p) => `${p.x} ${p.y}`).join("L")}`,
          fill: "none",
          stroke: color,
          "stroke-width": width,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
      if (object.data.endArrow)
        root.append(arrowHead(local.at(-1) as Point, local.at(-2) as Point, color, width));
      if (object.data.startArrow) root.append(arrowHead(local[0] as Point, local[1] as Point, color, width));
      el.append(root);
      break;
    }
    case "stroke": {
      place(el, pose);
      const pts = object.points.map((p) => ({ x: p.u * pose.w, y: p.v * pose.h }));
      const root = svg("svg", {
        width: pose.w,
        height: pose.h,
        viewBox: `0 0 ${pose.w} ${pose.h}`,
        overflow: "visible",
      });
      root.append(
        svg("path", {
          d: strokePath(pts),
          fill: "none",
          stroke: object.style.stroke,
          "stroke-width": Math.max(1, object.style.strokeWidth),
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      );
      el.append(root);
      break;
    }
    case "shape":
      place(el, pose);
      el.append(shapeSvg(object, pose));
      if (object.text) el.append(textNode(object, look));
      break;
    case "sticky":
      place(el, pose);
      el.style.background = object.style.fill === "transparent" ? "#fff2a8" : object.style.fill;
      el.append(textNode(object, look));
      break;
    case "text":
      place(el, pose);
      el.style.color = object.style.stroke;
      el.append(textNode(object, look));
      break;
    case "frame": {
      place(el, pose);
      el.style.borderColor = object.style.stroke;
      el.style.background = object.style.fill === "transparent" ? "" : object.style.fill;
      const label = document.createElement("div");
      label.className = "bo-title";
      label.textContent = object.label || "Frame";
      el.append(label);
      break;
    }
    case "image": {
      place(el, pose);
      const img = document.createElement("img");
      img.alt = object.alt;
      img.draggable = false;
      img.src = look.assetUrl(object.asset);
      el.append(img);
      break;
    }
    case "rendered_frame": {
      place(el, pose);
      const head = document.createElement("div");
      head.className = "bo-title mock";
      head.append(object.label || object.data.source.frame);
      const by = look.author(object.attribution.fields.data?.a ?? object.attribution.created.a);
      if (by?.kind === "agent") {
        const pen = document.createElement("span");
        pen.className = "by-agent";
        pen.textContent = ` ✎ ${by.name}`;
        head.append(pen);
      }
      head.append(` v${object.data.version}`);
      if (object.data.missing) {
        const gone = document.createElement("b");
        gone.className = "missing";
        gone.textContent = " Not in the latest publish";
        head.append(gone);
      }
      const img = document.createElement("img");
      img.alt = object.label || object.data.source.frame;
      img.draggable = false;
      img.src = look.renderUrl(object.data.renders.thumb);
      img.dataset.level = "thumb";
      el.append(head, img);
      break;
    }
  }
  if (look.eye && object.kind !== "connector") {
    const key = mainAuthor(object);
    const who = look.author(key);
    if (who) {
      const tag = document.createElement("div");
      tag.className = `bo-who${who.kind === "agent" ? " agent" : ""}`;
      if (who.kind === "agent") tag.textContent = `✎ ${who.name}`;
      else {
        const dot = document.createElement("i");
        dot.textContent = initials(who.name);
        tag.append(dot, who.name.split(/\s+/)[0] ?? who.name);
      }
      el.append(tag);
    }
  }
  return el;
}

function pointsBox(points: Point[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
}

/** What makes an object's element stale: its JSON, its world place, and its bound ends. */
function signature(scene: Scene, object: BoardObject, eye: boolean) {
  const world = worldPose(scene, object.id);
  const ends = object.kind === "connector" ? connectorPath(scene, object) : null;
  return JSON.stringify([object, world, ends, eye]);
}

export class BoardLayer {
  readonly el: HTMLElement;
  private readonly nodes = new Map<string, { el: HTMLElement; sig: string }>();
  private sequence = "";

  constructor(
    host: HTMLElement,
    private look: Look,
    className = "",
  ) {
    this.el = document.createElement("div");
    this.el.className = `blayer ${className}`.trim();
    host.append(this.el);
  }

  setLook(look: Partial<Look>) {
    this.look = { ...this.look, ...look };
  }

  /** Redraws what changed. `extra` classes mark objects (dimmed deletion proposals, review outlines). */
  draw(scene: Scene, marks: Map<string, string> = new Map()) {
    const keep = new Set<string>();
    for (const object of scene.order) {
      keep.add(object.id);
      const sig = signature(scene, object, this.look.eye) + (marks.get(object.id) ?? "");
      const node = this.nodes.get(object.id);
      if (node && node.sig === sig) continue;
      const el = objectElement(scene, object, this.look);
      const mark = marks.get(object.id);
      if (mark) el.classList.add(...mark.split(" "));
      if (node) node.el.replaceWith(el);
      this.nodes.set(object.id, { el, sig });
    }
    for (const [id, node] of this.nodes) {
      if (keep.has(id)) continue;
      node.el.remove();
      this.nodes.delete(id);
    }
    const sequence = scene.order.map((o) => o.id).join(",");
    if (sequence !== this.sequence) {
      this.sequence = sequence;
      this.el.append(...scene.order.map((o) => (this.nodes.get(o.id) as { el: HTMLElement }).el));
    }
  }

  element(id: string) {
    return this.nodes.get(id)?.el ?? null;
  }

  /**
   * Mock images by level of detail, as the legacy canvas does: thumbnails far away, full pictures for
   * at most 40 near ones, swapped after decode so nothing flashes blank.
   */
  detail(scene: Scene, view: { x: number; y: number; s: number; width: number; height: number }) {
    let full = 0;
    const dpr = window.devicePixelRatio || 1;
    for (const object of scene.order) {
      if (object.kind !== "rendered_frame") continue;
      const img = this.nodes.get(object.id)?.el.querySelector("img");
      const pose = worldPose(scene, object.id);
      if (!img || !pose) continue;
      const left = pose.x * view.s + view.x;
      const top = pose.y * view.s + view.y;
      const width = pose.w * view.s;
      const near =
        left < view.width * 2 &&
        left + width > -view.width &&
        top < view.height * 2 &&
        top + pose.h * view.s > -view.height;
      let level = "thumb";
      if (near && width >= 120 && full < MAX_FULL) {
        level = `${Math.min(3, Math.max(1, Math.ceil(view.s * dpr)))}x`;
        full += 1;
      }
      if (img.dataset.level === level) continue;
      img.dataset.level = level;
      const url = this.look.renderUrl(object.data.renders[level as "thumb"]);
      const next = new Image();
      next.src = url;
      next
        .decode()
        .then(() => {
          if (img.dataset.level === level) img.src = url;
        })
        .catch(() => {});
    }
  }

  destroy() {
    this.el.remove();
    this.nodes.clear();
  }
}
