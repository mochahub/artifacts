import type { CanvasFrame } from "@artifacts/schema";

export type Board = {
  key: string;
  title: string;
  subtitle?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type Pin = {
  id: string;
  n: number;
  frameKey: string;
  x: number;
  y: number;
  done?: boolean;
  draft?: boolean;
  active?: boolean;
};
type Rect = { x: number; y: number; w: number; h: number };
type Options = {
  renderUrl(hash: string): string;
  /** A tap on the canvas (no drag), with what's under it. */
  onTap(frame: CanvasFrame | null, at: { x: number; y: number }): void;
  onPin(pin: Pin): void;
  onFocus(frame: CanvasFrame | null): void;
};

const MAX_FULL = 40; // Decoded full-size images at once: this is what bounds memory on an iPhone (06).
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

/** Keeps a scale inside the zoom limits. NaN (a 0/0 somewhere in a gesture) keeps `fallback` instead of spreading. */
export function clampScale(s: number, fallback: number) {
  return Number.isNaN(s) ? fallback : Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * The scale at which a rectangle fits a box between the insets. Never zero or negative, which a box
 * shorter than its insets (a phone in landscape with the keyboard up) would otherwise give: the
 * canvas would flip over.
 */
export function fitScale(
  box: { width: number; height: number },
  rect: { w: number; h: number },
  insets: { top: number; bottom: number; side: number },
) {
  const fit = Math.min(
    (box.width - insets.side * 2) / rect.w,
    (box.height - insets.top - insets.bottom) / rect.h,
  );
  return clampScale(fit, 1);
}

/**
 * Boards come left to right (06). A tall screen wraps them into two columns, as board 02 draws it,
 * or four boards in a row come out tiny on a phone. Only positions on screen change, never anchors.
 */
export function arrange(boards: Board[], frames: CanvasFrame[], columns: number) {
  const GAP_X = 120;
  const GAP_Y = 180;
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(0, ...boards.filter((_, i) => i % columns === column).map((board) => board.w)),
  );
  const moved = new Map<string, { x: number; y: number }>();
  let top = 0;
  for (let row = 0; row * columns < boards.length; row++) {
    const inRow = boards.slice(row * columns, (row + 1) * columns);
    let left = 0;
    inRow.forEach((board, column) => {
      moved.set(board.key, { x: left - board.x, y: top - board.y });
      left += (widths[column] as number) + GAP_X;
    });
    top += Math.max(...inRow.map((board) => board.h)) + GAP_Y;
  }
  const at = (key: string) => moved.get(key) ?? { x: 0, y: 0 };
  return {
    boards: boards.map((board) => ({ ...board, x: board.x + at(board.key).x, y: board.y + at(board.key).y })),
    frames: frames.map((frame) => ({
      ...frame,
      x: frame.x + at(frame.board).x,
      y: frame.y + at(frame.board).y,
    })),
  };
}

/** Pan, zoom and level of detail, outside Preact: gestures must not re-render anything. */
export class CanvasEngine {
  x = 0;
  y = 0;
  s = 1;
  private readonly frames: CanvasFrame[];
  private readonly imgs = new Map<string, { el: HTMLImageElement; level: string; box: HTMLElement }>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pins: Pin[] = [];
  private pinEls = new Map<string, HTMLButtonElement>();
  private lodTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private velocity = { x: 0, y: 0 };
  private samples: { x: number; y: number; t: number }[] = [];
  private lastTap = 0;
  private down: { x: number; y: number; moved: boolean } | null = null;
  private pinch: { dist: number; s: number; mx: number; my: number } | null = null;
  private focused: string | null = null;
  commenting = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly world: HTMLElement,
    private readonly overlay: HTMLElement,
    allFrames: CanvasFrame[],
    allBoards: Board[],
    private readonly options: Options,
  ) {
    const tall = root.clientHeight > root.clientWidth;
    const { boards, frames } = arrange(allBoards, allFrames, tall ? 2 : Math.max(1, allBoards.length));
    this.frames = frames;
    for (const board of boards) {
      const label = document.createElement("div");
      label.className = "brd";
      label.style.left = `${board.x}px`;
      label.style.top = `${board.y - 72}px`;
      label.textContent = board.title;
      if (board.subtitle) {
        const small = document.createElement("small");
        small.textContent = board.subtitle;
        label.append(small);
      }
      world.append(label);
    }
    for (const frame of frames) {
      const box = document.createElement("div");
      box.className = `fr${frame.changed ? " chg" : ""}`;
      box.dataset.frame = frame.key;
      Object.assign(box.style, {
        left: `${frame.x}px`,
        top: `${frame.y}px`,
        width: `${frame.w}px`,
        height: `${frame.h}px`,
      });
      const img = document.createElement("img");
      img.alt = frame.title ?? frame.key;
      img.src = options.renderUrl(frame.renders.thumb);
      box.append(img);
      world.append(box);
      this.imgs.set(frame.key, { el: img, level: "thumb", box });
    }
    root.addEventListener("pointerdown", this.onDown);
    root.addEventListener("pointermove", this.onMove);
    root.addEventListener("pointerup", this.onUp);
    root.addEventListener("pointercancel", this.onUp);
    root.addEventListener("wheel", this.onWheel, { passive: false });
    this.apply();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    if (this.lodTimer) clearTimeout(this.lodTimer);
    this.root.removeEventListener("pointerdown", this.onDown);
    this.root.removeEventListener("pointermove", this.onMove);
    this.root.removeEventListener("pointerup", this.onUp);
    this.root.removeEventListener("pointercancel", this.onUp);
    this.root.removeEventListener("wheel", this.onWheel);
    this.world.replaceChildren();
    this.overlay.replaceChildren();
  }

  frameAt(wx: number, wy: number) {
    return this.frames.find((f) => wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h) ?? null;
  }

  private toWorld(sx: number, sy: number) {
    const box = this.root.getBoundingClientRect();
    return { x: (sx - box.left - this.x) / this.s, y: (sy - box.top - this.y) / this.s };
  }

  bounds(): Rect {
    const left = Math.min(...this.frames.map((f) => f.x));
    const top = Math.min(...this.frames.map((f) => f.y));
    const right = Math.max(...this.frames.map((f) => f.x + f.w));
    const bottom = Math.max(...this.frames.map((f) => f.y + f.h));
    return { x: left, y: top - 72, w: right - left, h: bottom - top + 72 };
  }

  /** Room for the capsule and toolbar, so a fitted frame isn't underneath them. */
  private insets() {
    return { top: 84, bottom: 96, side: 16 };
  }

  private target(rect: Rect) {
    const { top, bottom } = this.insets();
    const box = this.root.getBoundingClientRect();
    const s = fitScale(box, rect, this.insets());
    return {
      s,
      x: (box.width - rect.w * s) / 2 - rect.x * s,
      y: top + (box.height - top - bottom - rect.h * s) / 2 - rect.y * s,
    };
  }

  fitAll(animate = false) {
    if (this.frames.length > 0) this.go(this.target(this.bounds()), animate);
  }

  focusFrame(key: string, animate = true) {
    const frame = this.frames.find((f) => f.key === key);
    if (!frame) return;
    this.focused = key;
    this.options.onFocus(frame);
    this.go(this.target(frame), animate);
  }

  step(by: number) {
    const index = this.frames.findIndex((f) => f.key === this.focused);
    const next = this.frames[(index + by + this.frames.length) % this.frames.length];
    if (next) this.focusFrame(next.key);
  }

  zoomTo(s: number) {
    cancelAnimationFrame(this.raf);
    const box = this.root.getBoundingClientRect();
    this.zoomAround(s, box.left + box.width / 2, box.top + box.height / 2);
  }

  /** Keeps a world point at a screen point, for the comment sheet (06). */
  showPoint(wx: number, wy: number, screenY: number) {
    const box = this.root.getBoundingClientRect();
    this.go({ s: this.s, x: box.width / 2 - wx * this.s, y: screenY - wy * this.s }, true);
  }

  private go(to: { s: number; x: number; y: number }, animate: boolean) {
    cancelAnimationFrame(this.raf);
    if (!animate) {
      Object.assign(this, to);
      return this.apply();
    }
    const from = { s: this.s, x: this.x, y: this.y };
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 240);
      const e = 1 - (1 - t) ** 3;
      this.s = from.s + (to.s - from.s) * e;
      this.x = from.x + (to.x - from.x) * e;
      this.y = from.y + (to.y - from.y) * e;
      this.apply();
      if (t < 1) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private zoomAround(s: number, sx: number, sy: number) {
    const next = clampScale(s, this.s);
    const box = this.root.getBoundingClientRect();
    const ratio = next / this.s;
    this.x = sx - box.left - (sx - box.left - this.x) * ratio;
    this.y = sy - box.top - (sy - box.top - this.y) * ratio;
    this.s = next;
    this.apply();
  }

  /** Where a live frame goes, on top of the frame's picture. */
  liveHost(key: string) {
    return this.imgs.get(key)?.box ?? null;
  }

  closeLive(key: string) {
    this.imgs.get(key)?.box.querySelector(".live")?.remove();
  }

  setPins(pins: Pin[]) {
    this.pins = pins;
    const keep = new Set(pins.map((pin) => pin.id));
    for (const [id, el] of this.pinEls) {
      if (!keep.has(id)) {
        el.remove();
        this.pinEls.delete(id);
      }
    }
    for (const pin of pins) {
      let el = this.pinEls.get(pin.id);
      if (!el) {
        el = document.createElement("button");
        el.type = "button";
        this.overlay.append(el);
        this.pinEls.set(pin.id, el);
        el.addEventListener("click", () => this.options.onPin(pin));
      }
      el.className = `pin${pin.done ? " done" : ""}${pin.draft ? " draft" : ""}${pin.active ? " active" : ""}`;
      el.textContent = pin.draft ? "+" : String(pin.n);
      const frame = this.frames.find((f) => f.key === pin.frameKey);
      el.setAttribute(
        "aria-label",
        pin.draft ? "New comment" : `Comment ${pin.n} on ${frame?.title ?? pin.frameKey}`,
      );
    }
    this.placePins();
  }

  private placePins() {
    for (const pin of this.pins) {
      const el = this.pinEls.get(pin.id);
      const frame = this.frames.find((f) => f.key === pin.frameKey);
      if (!el || !frame) continue;
      const px = (frame.x + pin.x * frame.w) * this.s + this.x;
      const py = (frame.y + pin.y * frame.h) * this.s + this.y;
      el.style.transform = `translate(${px}px, ${py}px)`;
    }
  }

  private apply() {
    this.world.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.s})`;
    this.placePins();
    if (!this.lodTimer) {
      this.lodTimer = setTimeout(() => {
        this.lodTimer = null;
        this.updateDetail();
      }, 120);
    }
  }

  /** Level of detail (06): swaps only after decode, so frames never flash blank mid-pan. */
  private updateDetail() {
    const box = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    let full = 0;
    for (const frame of this.frames) {
      const entry = this.imgs.get(frame.key);
      if (!entry) continue;
      const left = frame.x * this.s + this.x;
      const top = frame.y * this.s + this.y;
      const width = frame.w * this.s;
      const height = frame.h * this.s;
      const near =
        left < box.width * 2 &&
        left + width > -box.width &&
        top < box.height * 2 &&
        top + height > -box.height;
      let level = "thumb";
      if (near && width >= 120 && full < MAX_FULL) {
        level = `${Math.min(3, Math.max(1, Math.ceil(this.s * dpr)))}x`;
        full += 1;
      }
      if (level === entry.level) continue;
      const url = this.options.renderUrl(frame.renders[level as keyof CanvasFrame["renders"]]);
      const next = new Image();
      next.src = url;
      entry.level = level;
      next
        .decode()
        .then(() => {
          if (entry.level === level) entry.el.src = url;
        })
        .catch(() => {});
    }
  }

  private readonly onDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest(".pin")) return;
    cancelAnimationFrame(this.raf);
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {} // Capture only keeps a drag alive past the edge; the gesture works without it.
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.samples = [];
    if (this.pointers.size === 1) this.down = { x: event.clientX, y: event.clientY, moved: false };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        s: this.s,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      if (this.down) this.down.moved = true;
    }
  };

  private readonly onMove = (event: PointerEvent) => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.x += mx - this.pinch.mx;
      this.y += my - this.pinch.my;
      this.pinch.mx = mx;
      this.pinch.my = my;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      // Two touches that began on one point have no distance to scale by: wait for them to part.
      if (this.pinch.dist < 1) {
        this.pinch.dist = dist;
        this.pinch.s = this.s;
      }
      if (this.pinch.dist >= 1) this.zoomAround((this.pinch.s * dist) / this.pinch.dist, mx, my);
      return;
    }
    if (this.down && Math.hypot(point.x - this.down.x, point.y - this.down.y) > TAP_SLOP)
      this.down.moved = true;
    if (this.down?.moved) {
      this.x += point.x - previous.x;
      this.y += point.y - previous.y;
      this.samples.push({ ...point, t: event.timeStamp });
      this.apply();
    }
  };

  private readonly onUp = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size > 0) return;
    const down = this.down;
    this.down = null;
    if (!down) return;
    if (down.moved) {
      this.coast(event.timeStamp);
      return;
    }
    const world = this.toWorld(event.clientX, event.clientY);
    const frame = this.frameAt(world.x, world.y);
    if (this.commenting) return this.options.onTap(frame, world);
    if (event.timeStamp - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = 0;
      if (frame && this.focused !== frame.key) this.focusFrame(frame.key);
      else {
        this.focused = null;
        this.options.onFocus(null);
        this.fitAll(true);
      }
      return;
    }
    this.lastTap = event.timeStamp;
    this.options.onTap(frame, world);
  };

  /** Inertia from the last 100 ms of velocity (06). */
  private coast(now: number) {
    const recent = this.samples.filter((sample) => now - sample.t < 100);
    if (recent.length < 2) return;
    const first = recent[0] as (typeof recent)[number];
    const last = recent.at(-1) as (typeof recent)[number];
    const dt = Math.max(1, last.t - first.t);
    this.velocity = { x: ((last.x - first.x) / dt) * 16, y: ((last.y - first.y) / dt) * 16 };
    const tick = () => {
      this.velocity.x *= 0.94;
      this.velocity.y *= 0.94;
      this.x += this.velocity.x;
      this.y += this.velocity.y;
      this.apply();
      if (Math.hypot(this.velocity.x, this.velocity.y) > 0.3) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      this.zoomAround(this.s * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    } else {
      this.x -= event.deltaX;
      this.y -= event.deltaY;
      this.apply();
    }
  };
}
