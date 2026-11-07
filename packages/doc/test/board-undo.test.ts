import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  addBoardObject,
  boardToY,
  deleteBoardObject,
  insertBoardText,
  newObject,
  setBoardText,
  setPlacement,
  validateBoard,
  yToBoard,
} from "../src/board.ts";
import { BoardUndo } from "../src/board-undo.ts";
import { A1, A2, everyKind, HASH, pose, STYLE } from "./board-fixtures.ts";

const NOW = Date.parse("2026-11-07T12:30:00.000Z");
const fork = (doc: Y.Doc, gc = false) => {
  const copy = new Y.Doc({ gc });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};
const find = (doc: Y.Doc, id: string) => yToBoard(doc).objects.find((o) => o.id === id);
const person = (doc: Y.Doc) => new BoardUndo(doc, () => "a2", { now: () => NOW });

describe("guarded board undo", () => {
  test("undoes and redoes the person's own move, restamped with their key", () => {
    const doc = boardToY(everyKind());
    const undo = person(doc);
    undo.gesture(() => setPlacement(doc, "~shape00001", { pose: pose(10, 10), parent: null }, A2));
    expect(find(doc, "~shape00001")?.pose).toEqual(pose(10, 10));
    expect(undo.undo()).toEqual({ done: true, skipped: [] });
    expect(find(doc, "~shape00001")?.pose).toEqual(pose(700, 0));
    expect(find(doc, "~shape00001")?.attribution.fields.pose?.a).toBe("a2");
    expect(undo.redo().done).toBe(true);
    expect(find(doc, "~shape00001")?.pose).toEqual(pose(10, 10));
  });

  test("skips an object a collaborator moved since, and reports it", () => {
    const doc = boardToY(everyKind());
    const other = fork(doc);
    const undo = person(doc);
    undo.gesture(() => {
      setPlacement(doc, "~shape00001", { pose: pose(10, 10), parent: null }, A2);
      setPlacement(doc, "~image00001", { pose: pose(20, 20), parent: null }, A2);
    });
    sync(doc, other);
    setPlacement(other, "~shape00001", { pose: pose(99, 99), parent: null }, A1);
    sync(doc, other);
    expect(undo.undo()).toEqual({ done: true, skipped: ["~shape00001"] });
    expect(find(doc, "~shape00001")?.pose).toEqual(pose(99, 99));
    expect(find(doc, "~image00001")?.pose).toEqual(pose(700, 200));
  });

  test("undoing a creation hides it; redo shows it again", () => {
    const doc = boardToY(everyKind());
    const undo = person(doc);
    undo.gesture(() =>
      addBoardObject(
        doc,
        newObject(
          {
            id: "~new0000001",
            kind: "sticky",
            pose: pose(5, 5),
            parent: null,
            order: "a9",
            label: "",
            style: STYLE,
            text: "hi",
          },
          A2,
        ),
      ),
    );
    expect(find(doc, "~new0000001")).toBeDefined();
    undo.undo();
    expect(find(doc, "~new0000001")).toBeUndefined();
    undo.redo();
    expect((find(doc, "~new0000001") as { text: string }).text).toBe("hi");
  });

  test("undoing the person's delete restores it and rebinds untouched connectors, after compaction", () => {
    const doc = boardToY(everyKind());
    const undo = person(doc);
    undo.gesture(() => deleteBoardObject(doc, "~shape00001", A2));
    expect(find(doc, "~shape00001")).toBeUndefined();
    // The server folds history through a garbage-collected document; the client's undo still applies.
    const server = fork(doc, true);
    const before = Y.encodeStateVector(doc);
    undo.undo();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc, before));
    for (const d of [doc, server]) {
      expect(find(d, "~shape00001")?.pose).toEqual(pose(700, 0));
      const c = find(d, "~conn000001");
      if (c?.kind !== "connector") throw new Error();
      expect(c.data.end.binding?.object).toBe("~shape00001");
      expect(validateBoard(d, { assets: new Set([HASH]) }).ok).toBe(true);
    }
  });

  test("never clears a foreign tombstone", () => {
    const doc = boardToY(everyKind());
    const other = fork(doc);
    const undo = person(doc);
    undo.gesture(() => deleteBoardObject(doc, "~shape00001", A2));
    sync(doc, other);
    // Someone else restores and deletes it again: the tombstone is theirs now.
    other.getMap("deleted").delete("~shape00001");
    deleteBoardObject(other, "~shape00001", A1);
    sync(doc, other);
    const result = undo.undo();
    expect(result.skipped).toContain("~shape00001");
    expect(find(doc, "~shape00001")).toBeUndefined();
  });

  test("text undo removes only the person's own typing", () => {
    const doc = boardToY(everyKind());
    const other = fork(doc);
    const undo = person(doc);
    undo.beginText("~sticky0001");
    doc.transact(() => insertBoardText(doc, "~sticky0001", 5, " big", A2), undo.textOrigin);
    doc.transact(() => insertBoardText(doc, "~sticky0001", 9, "!", A2), undo.textOrigin);
    undo.endText();
    sync(doc, other);
    setBoardText(other, "~sticky0001", "Hello big!\nwide world", A1);
    sync(doc, other);
    expect(undo.undo().done).toBe(true);
    expect((find(doc, "~sticky0001") as { text: string }).text).toBe("Hello\nwide world");
    expect(undo.redo().done).toBe(true);
    expect((find(doc, "~sticky0001") as { text: string }).text).toBe("Hello big!\nwide world");
  });

  test("tracks no remote or agent work", () => {
    const doc = boardToY(everyKind());
    const undo = person(doc);
    setPlacement(doc, "~shape00001", { pose: pose(1, 1), parent: null }, A1);
    expect(undo.canUndo).toBe(false);
    undo.clear();
    undo.destroy();
  });
});
