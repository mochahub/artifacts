/**
 * Who owns each pointer on a board (14, "Viewer, gestures and accessibility"), as a pure state machine
 * so the rules are proven without a browser:
 * - Only the pointer that started a stroke (or a tool drag) may extend, end or cancel it. An unrelated
 *   up or cancel, a second pen, a palm or a lost capture cannot commit or cut it short.
 * - Apple Pencil (`pointerType: pen`) draws when "Pencil draws" is on, whatever the tool; fingers
 *   navigate. Touches during a pen stroke are palms: ignored, and the board doesn't move under the pen.
 * - Two fingers always navigate. A second finger during a finger stroke cancels the uncommitted stroke
 *   and both fingers pinch.
 * - A stationary two-finger tap with no stroke is undo; any movement cancels that candidate.
 */

export type PointerKind = "pen" | "touch" | "mouse";
export type Input = { id: number; type: PointerKind; x: number; y: number; t: number };
/** What a fresh pointer should do, decided by the editor (it knows the tool and what's under the point). */
export type Route = "ink" | "tool" | "nav";
export type Action =
  | { t: "ink-start" | "ink-move" | "ink-end" | "tool-start" | "tool-move" | "tool-end"; p: Input }
  | { t: "ink-cancel" | "tool-cancel" }
  | { t: "nav-down" | "nav-move" | "nav-up"; p: Input }
  | { t: "undo" };

const TAP_SLOP = 10;
const TAP_MS = 350;

export class Arbiter {
  private ink: Input | null = null;
  private tool: Input | null = null;
  private readonly nav = new Map<number, Input>();
  private tap: { ids: Set<number>; from: Map<number, Input>; t: number; moved: boolean } | null = null;

  constructor(private readonly route: (p: Input) => Route) {}

  get busy() {
    return this.ink !== null || this.tool !== null;
  }
  get inking() {
    return this.ink !== null;
  }

  down(p: Input): Action[] {
    // A stroke by the Pencil owns the board: palms and a second pen are nothing at all.
    if (this.ink?.type === "pen") return [];
    if (this.ink || this.tool) {
      const owner = (this.ink ?? this.tool) as Input;
      if (owner.type === "touch" && p.type === "touch") {
        // The second finger: the uncommitted stroke or drag goes, and both fingers pinch.
        const out: Action[] = [this.ink ? { t: "ink-cancel" } : { t: "tool-cancel" }];
        this.ink = null;
        this.tool = null;
        this.nav.set(owner.id, owner);
        this.nav.set(p.id, p);
        out.push({ t: "nav-down", p: owner }, { t: "nav-down", p });
        return out;
      }
      return [];
    }
    // A finger already navigating: a second one pinches, whatever the tool.
    if (this.nav.size > 0 && p.type !== "pen") {
      this.nav.set(p.id, p);
      if (this.nav.size === 2 && p.type === "touch") {
        const first = [...this.nav.values()][0] as Input;
        const still = p.t - first.t < TAP_MS;
        this.tap = still
          ? { ids: new Set(this.nav.keys()), from: new Map(this.nav), t: first.t, moved: false }
          : null;
      } else this.tap = null;
      return [{ t: "nav-down", p }];
    }
    // A pen arriving while fingers navigate: they stop, the pen draws (it never joins a pinch).
    const route = this.route(p);
    if (route === "ink") {
      const out: Action[] = [];
      for (const finger of this.nav.values()) out.push({ t: "nav-up", p: finger });
      this.nav.clear();
      this.tap = null;
      this.ink = p;
      out.push({ t: "ink-start", p });
      return out;
    }
    if (route === "tool") {
      if (this.nav.size > 0) return [];
      this.tool = p;
      return [{ t: "tool-start", p }];
    }
    if (p.type === "pen") return [];
    this.nav.set(p.id, p);
    return [{ t: "nav-down", p }];
  }

  move(p: Input): Action[] {
    if (this.ink) {
      if (p.id !== this.ink.id) return [];
      this.ink = p;
      return [{ t: "ink-move", p }];
    }
    if (this.tool) {
      if (p.id !== this.tool.id) return [];
      this.tool = p;
      return [{ t: "tool-move", p }];
    }
    if (!this.nav.has(p.id)) return [];
    if (this.tap) {
      const from = this.tap.from.get(p.id);
      if (from && Math.hypot(p.x - from.x, p.y - from.y) > TAP_SLOP) this.tap.moved = true;
    }
    this.nav.set(p.id, p);
    return [{ t: "nav-move", p }];
  }

  /** Pointer up (`cancel` false) or cancel. Only the owner ends what it started. */
  up(p: Input, cancel = false): Action[] {
    if (this.ink) {
      if (p.id !== this.ink.id) return [];
      this.ink = null;
      return [cancel ? { t: "ink-cancel" } : { t: "ink-end", p }];
    }
    if (this.tool) {
      if (p.id !== this.tool.id) return [];
      this.tool = null;
      return [cancel ? { t: "tool-cancel" } : { t: "tool-end", p }];
    }
    if (!this.nav.has(p.id)) return [];
    this.nav.delete(p.id);
    const out: Action[] = [{ t: "nav-up", p }];
    const tap = this.tap;
    if (tap && this.nav.size === 0) {
      this.tap = null;
      if (!cancel && !tap.moved && p.t - tap.t < TAP_MS * 2 && tap.ids.has(p.id)) out.push({ t: "undo" });
    }
    return out;
  }

  /** Lost pointer capture changes nothing: only the owner's up or cancel ends a gesture. */
  lost(): Action[] {
    return [];
  }

  reset() {
    this.ink = null;
    this.tool = null;
    this.nav.clear();
    this.tap = null;
  }
}
