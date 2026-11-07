import { describe, expect, test } from "bun:test";
import { BoardSnapshot } from "@artifacts/schema/boards";
import * as Y from "yjs";
import {
  addBoardObject,
  boardEndpoint,
  boardObjects,
  boardText,
  boardTextOf,
  boardToY,
  boardWorldPose,
  deleteBoardObject,
  deletedMap,
  newObject,
  objectsMap,
  repairBoard,
  restoreBoardObject,
  setBoardText,
  setPlacement,
  setRegister,
  validateBoard,
  yToBoard,
} from "../src/board.ts";
import { boardBase, boardContentHash, boardHash, canonicalJSON } from "../src/board-hash.ts";
import { isBoardObjectId, mintBoardObjectId } from "../src/board-ids.ts";
import { compareSiblings, isOrderKey, keyBetween, keysBetween, rebalanceOrders } from "../src/board-order.ts";
import { A1, A2, everyKind, HASH, pose, STYLE } from "./board-fixtures.ts";

const ASSETS = new Set([HASH]);
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};
const fork = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const objectOf = (doc: Y.Doc, id: string) => yToBoard(doc).objects.find((o) => o.id === id);

describe("board ids", () => {
  test("mint lasting ids in the block id namespace", () => {
    const ids = new Set(Array.from({ length: 500 }, () => mintBoardObjectId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isBoardObjectId(id)).toBe(true);
  });
});

describe("fractional order keys", () => {
  test("generate strictly between neighbours, canonically", () => {
    let keys = ["a0"];
    for (let i = 0; i < 200; i++) {
      const at = i % (keys.length + 1);
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      expect(isOrderKey(key)).toBe(true);
      keys = [...keys.slice(0, at), key, ...keys.slice(at)];
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("reject malformed keys and compare by code point, ids breaking ties", () => {
    for (const bad of ["", "a00", "a-", "a0".padEnd(65, "1"), `A${"0".repeat(26)}`, "!"])
      expect(isOrderKey(bad)).toBe(false);
    expect(["b", "Z", "a"].sort()).toEqual(["Z", "a", "b"]);
    expect(compareSiblings({ order: "a0", id: "~b" }, { order: "a0", id: "~a" })).toBe(1);
    expect(keysBetween("a0", "a1", 5).every(isOrderKey)).toBe(true);
  });
  test("rebalance keeps current order", () => {
    const siblings = [
      { id: "~2", order: "a0" },
      { id: "~1", order: "a0" },
      { id: "~3", order: "Zz" },
    ];
    const next = rebalanceOrders(siblings);
    const sorted = [...next].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([id]) => id);
    expect(sorted).toEqual(["~3", "~1", "~2"]);
  });
});

describe("board model", () => {
  test("every kind round-trips through Y.Maps; text stays a Y.Text", () => {
    const input = everyKind();
    const doc = boardToY(input);
    expect(validateBoard(doc, { assets: ASSETS })).toEqual({ ok: true });
    expect(objectsMap(doc).get("~sticky0001")?.get("text")).toBeInstanceOf(Y.Text);
    const out = yToBoard(doc);
    expect(BoardSnapshot.safeParse(out).success).toBe(true);
    const strip = (s: typeof out) =>
      s.objects
        .map((o) => (o.kind === "connector" ? { ...o, pose: null } : o))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(strip(out)).toEqual(strip(input) as never);
    // Through an encoded update and a garbage-collected copy, stamps included.
    const copy = new Y.Doc({ gc: true });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(boardHash(yToBoard(copy))).toBe(boardHash(out));
    expect(yToBoard(boardToY(out))).toEqual(out);
  });

  test("connector pose is derived from endpoints and the elbow targets", () => {
    const out = yToBoard(boardToY(everyKind()));
    const c = out.objects.find((o) => o.id === "~conn000001");
    if (c?.kind !== "connector") throw new Error("no connector");
    const start = boardEndpoint(out, c.data.start);
    const end = boardEndpoint(out, c.data.end);
    expect(start).toEqual({ x: 120, y: 60 });
    expect(end).toEqual({ x: 700, y: 40 });
    expect(c.pose).toEqual({ x: 120, y: 40, w: 580, h: 20, angle: 0 });
  });

  test("hashes ignore key order and locale; pose changes the base, not the content hash", () => {
    const out = yToBoard(boardToY(everyKind()));
    const sticky = out.objects.find((o) => o.id === "~sticky0001");
    if (!sticky) throw new Error();
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(sticky) as typeof sticky;
    expect(boardBase(reordered)).toBe(boardBase(sticky));
    const moved = { ...sticky, pose: { ...sticky.pose, x: 21 } };
    expect(boardBase(moved)).not.toBe(boardBase(sticky));
    expect(boardContentHash(moved)).toBe(boardContentHash(sticky));
    expect(canonicalJSON({ b: -0, a: [1, "x"] })).toBe('{"a":[1,"x"],"b":0}');
    expect(() => canonicalJSON({ a: Number.NaN })).toThrow();
  });

  test("world poses add ancestor translations; text in outline order", () => {
    const out = yToBoard(boardToY(everyKind()));
    expect(boardWorldPose(out, "~sticky0001")).toEqual(pose(20, 20));
    expect(boardText(out)).toBe("Hello\nworld\n\nPlain 🙂");
  });

  test("validation refuses malformed and forbidden shapes", () => {
    const bad = (mutate: (doc: Y.Doc) => void, assets = ASSETS) => {
      const doc = boardToY(everyKind());
      mutate(doc);
      return validateBoard(doc, { assets }).ok;
    };
    expect(bad(() => {})).toBe(true);
    expect(
      bad((d) =>
        setRegister(
          d,
          "~sticky0001",
          "placement",
          { pose: pose(Number.NaN, 0), parent: null, worldPose: pose(0, 0) },
          A1,
        ),
      ),
    ).toBe(false);
    expect(
      bad((d) => setPlacement(d, "~frame00001", { pose: pose(0, 0, 10, 10, 0.3), parent: null }, A1)),
    ).toBe(false);
    expect(bad((d) => setPlacement(d, "~sticky0001", { pose: pose(0, 0), parent: "~shape00001" }, A1))).toBe(
      false,
    );
    expect(bad((d) => setPlacement(d, "~sticky0001", { pose: pose(2_000_000, 0), parent: null }, A1))).toBe(
      false,
    );
    expect(bad((d) => setRegister(d, "~sticky0001", "order", "a00", A1))).toBe(false);
    expect(bad((d) => objectsMap(d).get("~sticky0001")?.set("extra", 1))).toBe(false);
    expect(bad((d) => d.getMap("other").set("x", 1))).toBe(false);
    expect(bad(() => {}, new Set())).toBe(false);
    expect(bad((d) => setBoardText(d, "~sticky0001", "x".repeat(16_001), A1))).toBe(false);
    expect(
      bad((d) => {
        const c = objectOf(d, "~conn000001");
        if (c?.kind !== "connector") throw new Error();
        setRegister(
          d,
          c.id,
          "data",
          { ...c.data, end: { point: { x: 0, y: 0 }, binding: { object: c.id, u: 0, v: 0 } } },
          A1,
        );
      }),
    ).toBe(false);
    expect(bad((d) => boardTextOf(d, "~text000001")?.insert(0, "x", { bold: true }))).toBe(false);
    // An unauthored span (Yjs format cleanup after a merge) takes its neighbour's author, never refused.
    const gap = boardToY(everyKind());
    boardTextOf(gap, "~text000001")?.insert(0, "x");
    expect(validateBoard(gap, { assets: ASSETS }).ok).toBe(true);
    expect(yToBoard(gap).objects.find((o) => o.id === "~text000001")?.attribution.text).toEqual([
      { s: 0, e: 9, a: "a1", t: "2026-11-07T12:00:00.000Z" },
    ]);
    expect(
      bad((d) =>
        addBoardObject(
          d,
          newObject(
            {
              id: "~render0002",
              kind: "rendered_frame",
              pose: pose(0, 0),
              parent: null,
              order: "a9",
              label: "",
              style: STYLE,
              data: (objectOf(d, "~render0001") as unknown as { data: never }).data,
            },
            A1,
          ),
        ),
      ),
    ).toBe(false);
  });
});

describe("two writers", () => {
  test("a person's drag and an agent's text edit on the same object both land", () => {
    const base = boardToY(everyKind());
    const person = fork(base);
    const agent = fork(base);
    setPlacement(person, "~sticky0001", { pose: pose(50, 60), parent: "~frame00001" }, A2);
    setBoardText(agent, "~sticky0001", "Hello\nbrave world", A1);
    sync(person, agent);
    const a = objectOf(person, "~sticky0001");
    expect(a?.pose).toEqual(pose(50, 60));
    expect((a as { text: string }).text).toBe("Hello\nbrave world");
    expect(yToBoard(person)).toEqual(yToBoard(agent));
  });

  test("two competing full poses converge to one whole pose, never a mix", () => {
    const base = boardToY(everyKind());
    const one = fork(base);
    const two = fork(base);
    setPlacement(one, "~sticky0001", { pose: pose(1, 2, 30, 40, 0.1), parent: "~frame00001" }, A1);
    setPlacement(two, "~sticky0001", { pose: pose(9, 8, 70, 60, -0.2), parent: null }, A2);
    sync(one, two);
    const p = objectOf(one, "~sticky0001");
    expect([canonicalJSON(pose(1, 2, 30, 40, 0.1)), canonicalJSON(pose(9, 8, 70, 60, -0.2))]).toContain(
      canonicalJSON(p?.pose),
    );
    expect(yToBoard(one)).toEqual(yToBoard(two));
  });

  test("concurrent text inserts merge with both authors", () => {
    const base = boardToY(everyKind());
    const one = fork(base);
    const two = fork(base);
    setBoardText(one, "~sticky0001", "Hello there\nworld", A1);
    setBoardText(two, "~sticky0001", "Hello\nworld!", A2);
    sync(one, two);
    const s = objectOf(one, "~sticky0001") as { text: string; attribution: { text: { a: string }[] } };
    expect(s.text).toBe("Hello there\nworld!");
    expect(new Set(s.attribution.text.map((r) => r.a))).toEqual(new Set(["a1", "a2"]));
  });

  test("delete wins over a concurrent edit; restore reveals the edit", () => {
    const base = boardToY(everyKind());
    const one = fork(base);
    const two = fork(base);
    deleteBoardObject(one, "~shape00001", A1);
    setBoardText(two, "~shape00001", "late", A2);
    setPlacement(two, "~shape00001", { pose: pose(800, 0), parent: null }, A2);
    sync(one, two);
    expect(objectOf(one, "~shape00001")).toBeUndefined();
    expect(yToBoard(one)).toEqual(yToBoard(two));
    restoreBoardObject(one, "~shape00001");
    expect((objectOf(one, "~shape00001") as { text: string }).text).toBe("late");
  });

  test("a connector bound to a deleted target detaches at the target's last position", () => {
    const base = boardToY(everyKind());
    const one = fork(base);
    const two = fork(base);
    deleteBoardObject(one, "~shape00001", A1);
    // Concurrently, someone moves the target: the delete still wins, at its own frozen position.
    setPlacement(two, "~shape00001", { pose: pose(5000, 5000), parent: null }, A2);
    sync(one, two);
    const c = objectOf(two, "~conn000001");
    if (c?.kind !== "connector") throw new Error();
    expect(c.data.end).toEqual({ point: { x: 700, y: 40 }, binding: null });
    expect(Number.isFinite(c.pose.w)).toBe(true);
    // An offline writer who never saw the unbinding binds to the deleted object: projection detaches it.
    const three = fork(base);
    deletedMap(three).set("~shape00001", {
      a: "a1",
      t: "2026-11-07T12:00:00.000Z",
      pose: pose(700, 0),
      parent: null,
      worldPose: pose(700, 0),
    });
    const repair = repairBoard(three);
    expect(repair).not.toBeNull();
    expect(validateBoard(three, { assets: ASSETS }).ok).toBe(true);
    expect(repairBoard(three)).toBeNull();
  });

  test("deleting a frame ungroups its children in place", () => {
    const doc = boardToY(everyKind());
    deleteBoardObject(doc, "~frame00001", A1);
    const out = yToBoard(doc);
    expect(out.objects.find((o) => o.id === "~sticky0001")?.parent).toBeNull();
    expect(boardWorldPose(out, "~sticky0001")).toEqual(pose(20, 20));
    expect(out.deleted.map((d) => d.id)).toEqual(["~frame00001"]);
  });

  test("concurrent reparent cycles detach the greatest id at its frozen board pose", () => {
    const base = boardToY(everyKind());
    addBoardObject(
      base,
      newObject(
        {
          id: "~frame00002",
          kind: "frame",
          pose: pose(1000, 1000, 300, 300),
          parent: null,
          order: "a5",
          label: "",
          style: STYLE,
        },
        A1,
      ),
    );
    const one = fork(base);
    const two = fork(base);
    setPlacement(one, "~frame00001", { pose: pose(10, 10, 600, 400), parent: "~frame00002" }, A1);
    setPlacement(two, "~frame00002", { pose: pose(5, 5, 300, 300), parent: "~frame00001" }, A2);
    sync(one, two);
    const out = yToBoard(one);
    expect(out.objects.find((o) => o.id === "~frame00002")?.parent).toBeNull();
    expect(out.objects.find((o) => o.id === "~frame00002")?.pose).toEqual(pose(5, 5, 300, 300));
    expect(out.objects.find((o) => o.id === "~frame00001")?.parent).toBe("~frame00002");
    expect(validateBoard(one, { assets: ASSETS }).ok).toBe(true);
    const fix = repairBoard(one);
    expect(fix).not.toBeNull();
    Y.applyUpdate(two, fix as Uint8Array);
    expect(yToBoard(two)).toEqual(out);
  });

  test("concurrent reorders converge to one whole key; reorder and move both land", () => {
    for (const first of [0, 1]) {
      const base = boardToY(everyKind());
      const one = fork(base);
      const two = fork(base);
      setRegister(one, "~shape00001", "order", keyBetween(null, "a1"), A1);
      setRegister(two, "~shape00001", "order", keyBetween("a4", null), A2);
      setPlacement(two, "~image00001", { pose: pose(5, 5), parent: null }, A2);
      setRegister(one, "~image00001", "order", keyBetween("a4", null), A1);
      if (first) sync(two, one);
      else sync(one, two);
      expect(yToBoard(one)).toEqual(yToBoard(two));
      expect([keyBetween(null, "a1"), keyBetween("a4", null)]).toContain(
        objectOf(one, "~shape00001")?.order ?? "",
      );
      expect(objectOf(one, "~image00001")?.pose).toEqual(pose(5, 5));
      expect(objectOf(one, "~image00001")?.order).toBe(keyBetween("a4", null));
    }
  });

  test("two creators with equal order keys draw deterministically by id", () => {
    const base = boardToY(everyKind());
    const one = fork(base);
    const two = fork(base);
    addBoardObject(
      one,
      newObject(
        {
          id: "~zzzzzzzzz1",
          kind: "text",
          pose: pose(0, 0),
          parent: null,
          order: "a9",
          label: "",
          style: STYLE,
          text: "1",
        },
        A1,
      ),
    );
    addBoardObject(
      two,
      newObject(
        {
          id: "~aaaaaaaaa1",
          kind: "text",
          pose: pose(0, 0),
          parent: null,
          order: "a9",
          label: "",
          style: STYLE,
          text: "2",
        },
        A2,
      ),
    );
    sync(one, two);
    expect(yToBoard(one)).toEqual(yToBoard(two));
    expect(boardObjects(one).size).toBe(10);
  });
});
