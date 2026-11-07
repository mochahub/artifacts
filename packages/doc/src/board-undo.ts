import * as Y from "yjs";
import {
  boardObjects,
  boardStamp,
  canonicalJSON,
  deleteBoardObject,
  deletedMap,
  objectsMap,
  REGISTERS,
  type Register,
  type RegisterKey,
  type Tombstone,
} from "./board.ts";

/**
 * Guarded local undo for a person's board gestures (14, "Yjs mapping and concurrency"). It tracks only
 * this person's own gesture and typing origins, never remote updates, agent operations, repairs or
 * checkpoints. Each step is checked against the current state before it is reversed: a register a
 * collaborator has since changed, a foreign tombstone or a collaborator's object is left alone and its
 * id reported as skipped ("That object changed; undo skipped it"). Restored register values are stamped
 * with the undoing person's key, so the server's attribution check holds without trusting old stamps;
 * restoring a deletion clears only this person's own tombstone, which the server verifies.
 */

type Entry =
  | {
      type: "register";
      id: string;
      key: RegisterKey;
      before: Register<unknown> | null;
      after: Register<unknown>;
    }
  | { type: "created"; id: string }
  | { type: "tomb"; id: string; before: Tombstone | null; after: Tombstone | null };
type Item = { kind: "gesture"; entries: Entry[] } | { kind: "text"; id: string; manager: Y.UndoManager };

export type UndoResult = { done: boolean; skipped: string[] };

const same = (a: unknown, b: unknown) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  try {
    return canonicalJSON(a) === canonicalJSON(b);
  } catch {
    return false;
  }
};

export class BoardUndo {
  /** Transaction origin for this person's gestures; pass it to `doc.transact` (or use `gesture`). */
  readonly origin = { board: "gesture" };
  /** Transaction origin for this person's typing in an object's text. */
  readonly textOrigin = { board: "text" };
  private readonly undoOrigin = { board: "undo" };
  private undoStack: Item[] = [];
  private redoStack: Item[] = [];
  private collecting: Entry[] | null = null;
  private session: { id: string; manager: Y.UndoManager } | null = null;
  private readonly observer: (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => void;
  private readonly tombObserver: (event: Y.YMapEvent<Tombstone>, tr: Y.Transaction) => void;

  constructor(
    private readonly doc: Y.Doc,
    /** This connection's author key, from the sync `hello`. */
    private readonly author: () => string | null,
    private readonly opts: { max?: number; now?: () => number } = {},
  ) {
    this.observer = (events, tr) => {
      if (!this.collecting || (tr.origin !== this.origin && tr.origin !== this.undoOrigin)) return;
      for (const event of events) {
        if (event.target === objectsMap(doc)) {
          for (const [key, change] of (event as Y.YMapEvent<unknown>).changes.keys)
            if (change.action === "add") this.collecting.push({ type: "created", id: key });
          continue;
        }
        if (!(event.target instanceof Y.Map) || event.target.parent !== objectsMap(doc)) continue;
        const id = String(event.target.get("id"));
        for (const [key, change] of (event as Y.YMapEvent<unknown>).changes.keys) {
          if (!(REGISTERS as readonly string[]).includes(key) || change.action !== "update") continue;
          this.collecting.push({
            type: "register",
            id,
            key: key as RegisterKey,
            before: (change.oldValue as Register<unknown>) ?? null,
            after: event.target.get(key) as Register<unknown>,
          });
        }
      }
    };
    this.tombObserver = (event, tr) => {
      if (!this.collecting || (tr.origin !== this.origin && tr.origin !== this.undoOrigin)) return;
      for (const [id, change] of event.changes.keys)
        this.collecting.push({
          type: "tomb",
          id,
          before: change.action === "add" ? null : (change.oldValue as Tombstone),
          after: change.action === "delete" ? null : (deletedMap(doc).get(id) ?? null),
        });
    };
    objectsMap(doc).observeDeep(this.observer);
    deletedMap(doc).observe(this.tombObserver);
  }

  private stamp() {
    const a = this.author();
    if (!a) throw new Error("no author key yet");
    return boardStamp(a, this.opts.now?.() ?? Date.now());
  }

  private push(stack: Item[], item: Item) {
    stack.push(item);
    const max = this.opts.max ?? 100;
    while (stack.length > max) {
      const dropped = stack.shift();
      if (dropped?.kind === "text") dropped.manager.destroy();
    }
  }

  private collect(fn: () => void, origin: object): Entry[] {
    this.collecting = [];
    try {
      this.doc.transact(fn, origin);
      return this.collecting;
    } finally {
      this.collecting = null;
    }
  }

  /** One gesture (drag, resize, stroke, group, delete, keyboard nudge): one undo item. */
  gesture(fn: () => void): void {
    this.endText();
    const entries = this.collect(fn, this.origin);
    if (entries.length === 0) return;
    this.push(this.undoStack, { kind: "gesture", entries });
    for (const item of this.redoStack.splice(0)) if (item.kind === "text") item.manager.destroy();
  }

  /**
   * Typing into an object's text: transact with `textOrigin`. Coalesces into one item until focus
   * changes (`endText`) or another gesture starts. Yjs' own text undo removes only this person's
   * insertions and restores only their deletions, so concurrent typing survives.
   */
  beginText(id: string): void {
    if (this.session?.id === id) return;
    this.endText();
    const text = objectsMap(this.doc).get(id)?.get("text");
    if (!(text instanceof Y.Text)) return;
    const manager = new Y.UndoManager(text, {
      trackedOrigins: new Set([this.textOrigin]),
      captureTimeout: 2 ** 31,
    });
    this.session = { id, manager };
  }

  endText(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.manager.stopCapturing();
    if (session.manager.undoStack.length === 0) {
      session.manager.destroy();
      return;
    }
    this.push(this.undoStack, { kind: "text", id: session.id, manager: session.manager });
    for (const item of this.redoStack.splice(0)) if (item.kind === "text") item.manager.destroy();
  }

  get canUndo() {
    return this.undoStack.length > 0 || (this.session?.manager.undoStack.length ?? 0) > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo(): UndoResult {
    this.endText();
    const item = this.undoStack.pop();
    if (!item) return { done: false, skipped: [] };
    return this.reverse(item, this.redoStack, "undo");
  }

  redo(): UndoResult {
    this.endText();
    const item = this.redoStack.pop();
    if (!item) return { done: false, skipped: [] };
    return this.reverse(item, this.undoStack, "redo");
  }

  private reverse(item: Item, into: Item[], way: "undo" | "redo"): UndoResult {
    if (item.kind === "text") {
      const ok = way === "undo" ? item.manager.undo() : item.manager.redo();
      if (way === "undo" ? item.manager.redoStack.length : item.manager.undoStack.length) into.push(item);
      return { done: ok !== null, skipped: ok === null ? [item.id] : [] };
    }
    const skipped = new Set<string>();
    const stamp = this.stamp();
    const entries = this.collect(() => {
      for (const entry of [...item.entries].reverse()) {
        const map = objectsMap(this.doc).get(entry.id);
        if (!(map instanceof Y.Map)) {
          skipped.add(entry.id);
          continue;
        }
        if (entry.type === "register") {
          if (!entry.before || !same(map.get(entry.key), entry.after)) {
            skipped.add(entry.id);
            continue;
          }
          map.set(entry.key, { value: entry.before.value, a: stamp.a, t: stamp.t });
        } else if (entry.type === "created") {
          // Undoing a creation deletes it, if it is still this person's live object.
          if (!boardObjects(this.doc).has(entry.id)) skipped.add(entry.id);
          else deleteBoardObject(this.doc, entry.id, stamp);
        } else {
          const current = deletedMap(this.doc).get(entry.id) ?? null;
          if (!same(current, entry.after) || (entry.after && entry.after.a !== stamp.a)) {
            skipped.add(entry.id);
            continue;
          }
          if (entry.before === null) deletedMap(this.doc).delete(entry.id);
          else deletedMap(this.doc).set(entry.id, { ...entry.before, a: stamp.a, t: stamp.t });
        }
      }
    }, this.undoOrigin);
    // What this pass changed is the opposite item; a creation undone becomes a tombstone to clear.
    if (entries.length)
      this.push(into, { kind: "gesture", entries: entries.filter((e) => e.type !== "created") });
    return { done: entries.length > 0, skipped: [...skipped] };
  }

  /** Epoch reset or leaving Edit: history goes; unsent changes are the provider's, not ours. */
  clear(): void {
    this.endText();
    for (const item of [...this.undoStack, ...this.redoStack])
      if (item.kind === "text") item.manager.destroy();
    this.undoStack = [];
    this.redoStack = [];
  }

  destroy(): void {
    this.clear();
    objectsMap(this.doc).unobserveDeep(this.observer);
    deletedMap(this.doc).unobserve(this.tombObserver);
  }
}
