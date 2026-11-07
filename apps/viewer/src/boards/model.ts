import {
  addBoardObject,
  boardStamp,
  deleteBoardObject,
  getRegister,
  newObject,
  setBoardText,
  setPlacement,
  setRegister,
  yToBoard,
} from "@artifacts/doc/board";
import { mintFreshBoardObjectId } from "@artifacts/doc/board-ids";
import { keyBetween } from "@artifacts/doc/board-order";
import { BoardUndo, type UndoResult } from "@artifacts/doc/board-undo";
import type { BoardObject, BoardPose, BoardStyle } from "@artifacts/schema/boards";
import type * as Y from "yjs";
import { type Scene, sceneOf } from "./geometry.ts";

/**
 * The editor's one seam onto the board model (`@artifacts/doc/board`, 14 "Yjs mapping"): every write
 * goes through the model's stamped registers with this connection's author key from `hello`, and every
 * gesture through its guarded undo, which never overwrites a collaborator's newer change.
 */
export { boardToY, deletedMap, objectsMap, yToBoard } from "@artifacts/doc/board";
export { mintBoardObjectId } from "@artifacts/doc/board-ids";
export type { UndoResult };

type BoardConnectorData = Extract<BoardObject, { kind: "connector" }>["data"];

export type NewObject =
  | { kind: "sticky" | "text"; text: string }
  | { kind: "shape"; shape: "rect" | "ellipse" | "diamond" | "line"; text: string }
  | { kind: "image"; asset: string; alt: string }
  | { kind: "frame" }
  | { kind: "stroke"; points: { u: number; v: number; pressure: number }[] }
  | { kind: "connector"; data: BoardConnectorData };

/** Browser defaults (14, "Objects"): object content, independent of the viewer's theme. */
export const DEFAULT_STYLE: BoardStyle = {
  fill: "transparent",
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left",
};

const taken = (doc: Y.Doc, id: string) => doc.getMap("objects").has(id) || doc.getMap("deleted").has(id);

export class BoardWriter {
  readonly undo: BoardUndo;

  constructor(
    private readonly doc: Y.Doc,
    private readonly author: () => string | null,
  ) {
    this.undo = new BoardUndo(doc, author);
  }

  private stamp() {
    const a = this.author();
    if (!a) throw new Error("no author yet");
    return boardStamp(a);
  }

  get ready() {
    return !!this.author();
  }

  scene(): Scene {
    return sceneOf(yToBoard(this.doc));
  }

  /** One gesture, one undo item: a drag, a resize, a stroke, a delete, a keyboard nudge. */
  transact(fn: () => void) {
    this.undo.gesture(fn);
  }

  private lastOrder(parent: string | null) {
    let last: string | null = null;
    for (const object of this.scene().order)
      if (object.parent === parent && (last === null || object.order > last)) last = object.order;
    return last;
  }

  /** A new object with a fresh id, last among its siblings. Returns its id. */
  add(
    object: NewObject,
    pose: BoardPose,
    options: { parent?: string | null; style?: Partial<BoardStyle>; label?: string } = {},
  ) {
    const id = mintFreshBoardObjectId((candidate) => taken(this.doc, candidate));
    const parent = options.parent ?? null;
    const style = {
      ...DEFAULT_STYLE,
      ...(object.kind === "sticky" ? { fill: "#fff2a8" } : {}),
      ...options.style,
    };
    const json = newObject(
      {
        ...object,
        id,
        pose,
        parent,
        order: keyBetween(this.lastOrder(parent), null),
        label: options.label ?? "",
        style,
      } as never,
      this.stamp(),
    );
    addBoardObject(this.doc, json);
    return id;
  }

  /** One atomic placement register: pose and parent together, never five scalars. */
  place(id: string, pose: BoardPose, parent?: string | null) {
    const current = getRegister<{ parent: string | null }>(this.doc, id, "placement");
    setPlacement(
      this.doc,
      id,
      { pose, parent: parent === undefined ? (current?.value.parent ?? null) : parent },
      this.stamp(),
    );
  }

  setStyle(id: string, patch: Partial<BoardStyle>) {
    const current = getRegister<BoardStyle>(this.doc, id, "style")?.value ?? DEFAULT_STYLE;
    setRegister(this.doc, id, "style", { ...current, ...patch }, this.stamp());
  }

  setLabel(id: string, label: string) {
    setRegister(this.doc, id, "label", label, this.stamp());
  }

  setData(id: string, value: unknown) {
    setRegister(this.doc, id, "data", value, this.stamp());
  }

  /** Typing: a character diff on the same Y.Text, coalesced into one undo item until focus moves. */
  setText(id: string, next: string) {
    this.undo.beginText(id);
    this.doc.transact(() => setBoardText(this.doc, id, next, this.stamp()), this.undo.textOrigin);
  }

  endText() {
    this.undo.endText();
  }

  reorder(id: string, to: "front" | "back") {
    const scene = this.scene();
    const object = scene.objects.get(id);
    if (!object) return;
    const siblings = scene.order.filter((o) => o.parent === object.parent && o.id !== id).map((o) => o.order);
    const key =
      to === "front"
        ? keyBetween(
            siblings.reduce<string | null>((m, o) => (m === null || o > m ? o : m), null),
            null,
          )
        : keyBetween(
            null,
            siblings.reduce<string | null>((m, o) => (m === null || o < m ? o : m), null),
          );
    setRegister(this.doc, id, "order", key, this.stamp());
  }

  /** Remove-wins: frames ungroup, bound arrows let go where it was; undo restores the same id. */
  remove(id: string) {
    deleteBoardObject(this.doc, id, this.stamp());
  }
}
