import { expect, test } from "bun:test";
import * as Y from "yjs";
import {
  addBoardObject,
  boardToY,
  deleteBoardObject,
  newObject,
  objectsMap,
  repairBoard,
  reparentPreserving,
  restoreBoardObject,
  type Stamp,
  setBoardText,
  setPlacement,
  setRegister,
  validateBoard,
  yToBoard,
} from "../src/board.ts";
import { boardHash } from "../src/board-hash.ts";
import { keyBetween } from "../src/board-order.ts";
import { everyKind, HASH, pose, STYLE, T } from "./board-fixtures.ts";

const ASSETS = new Set([HASH]);

/** mulberry32: a small seeded generator, so a failing run can be replayed by its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Replica = { doc: Y.Doc; stamp: Stamp; inbox: Uint8Array[] };

function step(r: Replica, random: () => number, n: number) {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)] as T;
  const snapshot = yToBoard(r.doc);
  const active = snapshot.objects;
  const frames = active.filter((o) => o.kind === "frame");
  const target = active.length ? pick(active) : null;
  const choice = random();
  if (!target || choice < 0.1) {
    const id = `~s${String(n).padStart(4, "0")}${r.stamp.a.padStart(5, "0")}`;
    const order = keyBetween(null, null);
    addBoardObject(
      r.doc,
      newObject(
        {
          id,
          kind: random() < 0.3 ? "frame" : "sticky",
          pose: pose(Math.floor(random() * 2000), Math.floor(random() * 2000)),
          parent: null,
          order,
          label: "",
          style: STYLE,
          ...(random() < 0.3 ? {} : { text: "x" }),
        } as never,
        r.stamp,
      ),
    );
    return;
  }
  if (choice < 0.4 && target.kind !== "connector") {
    const p = { ...target.pose, x: target.pose.x + Math.floor(random() * 200 - 100), y: target.pose.y + 7 };
    if (target.kind !== "frame") p.angle = Math.round((random() * 2 - 1) * 100) / 100;
    setPlacement(r.doc, target.id, { pose: p, parent: target.parent }, r.stamp);
  } else if (choice < 0.55 && "text" in target) {
    const text = target.text;
    let at = Math.floor(random() * (text.length + 1));
    // Edit between characters, never inside a surrogate pair.
    if (/[\uDC00-\uDFFF]/.test(text[at] ?? "")) at -= 1;
    setBoardText(
      r.doc,
      target.id,
      text.slice(0, at) + pick(["a", "bc", "", "\n"]) + text.slice(at + (random() < 0.3 ? 1 : 0)),
      r.stamp,
    );
  } else if (choice < 0.65) {
    deleteBoardObject(r.doc, target.id, r.stamp);
  } else if (choice < 0.72) {
    const own = [...r.doc.getMap<{ a: string }>("deleted").entries()].filter(
      ([id, t]) => t.a === r.stamp.a && objectsMap(r.doc).has(id),
    );
    if (own.length) restoreBoardObject(r.doc, pick(own)[0]);
  } else if (choice < 0.85 && frames.length && target.kind !== "connector") {
    const frame = pick(frames);
    if (frame.id !== target.id)
      reparentPreserving(r.doc, target.id, random() < 0.3 ? null : frame.id, r.stamp);
  } else if (choice < 0.95) {
    const c = active.find((o) => o.kind === "connector");
    const to = pick(active.filter((o) => o.kind !== "connector"));
    if (c?.kind === "connector" && to)
      setRegister(
        r.doc,
        c.id,
        "data",
        { ...c.data, end: { point: { x: 1, y: 1 }, binding: { object: to.id, u: 0.5, v: 0.5 } } },
        r.stamp,
      );
  } else if (choice < 0.97) {
    // Reorder among siblings: a key strictly between two neighbours (or past the end).
    const siblings = active
      .filter((o) => o.parent === target.parent && o.id !== target.id)
      .map((o) => o.order)
      .sort();
    const at = Math.floor(random() * (siblings.length + 1));
    const lo = siblings[at - 1] ?? null;
    const hi = siblings[at] ?? null;
    if (lo === null || hi === null || lo < hi)
      setRegister(r.doc, target.id, "order", keyBetween(lo, hi), r.stamp);
  } else {
    setRegister(
      r.doc,
      target.id,
      "style",
      { ...target.style, opacity: Math.round(random() * 100) / 100 },
      r.stamp,
    );
  }
}

test("200 seeded runs with dropped, duplicated and reordered messages converge and stay valid", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = rng(seed);
    const seedDoc = new Y.Doc();
    seedDoc.clientID = 7;
    const base = Y.encodeStateAsUpdate(boardToY(everyKind(), seedDoc));
    const replicas: Replica[] = ["a1", "a2", "a3"].map((a) => {
      // Client ids decide Yjs conflicts: fixed per seed, so a failing seed replays exactly.
      const doc = new Y.Doc();
      doc.clientID = Math.floor(random() * 2 ** 31);
      Y.applyUpdate(doc, base);
      return { doc, stamp: { a, t: T }, inbox: [] };
    });
    const log: Uint8Array[] = [];
    // Anything a replica's own document emits (Yjs' text-format cleanup after a merge included) is sent
    // on, as a provider sends every local update.
    const REMOTE = "remote";
    for (const r of replicas)
      r.doc.on("update", (u: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return;
        log.push(u);
        for (const other of replicas) if (other !== r) other.inbox.push(u);
      });
    for (let n = 0; n < 30; n++) {
      const r = replicas[Math.floor(random() * replicas.length)] as Replica;
      // A writer only sends what the server would accept: try it on a copy first.
      const trial = new Y.Doc();
      trial.clientID = 1 + Math.floor(random() * 2 ** 31);
      Y.applyUpdate(trial, Y.encodeStateAsUpdate(r.doc));
      // What a provider sends: the transaction's own update, whose delete set is only its own deletions.
      const sent: Uint8Array[] = [];
      trial.on("update", (u: Uint8Array) => sent.push(u));
      try {
        trial.transact(() => step({ ...r, doc: trial }, random, n));
      } catch {
        continue;
      }
      if (sent.length === 0 || !validateBoard(trial, { assets: ASSETS }).ok) continue;
      const update = Y.mergeUpdates(sent);
      Y.applyUpdate(r.doc, update, REMOTE);
      log.push(update);
      for (const other of replicas) if (other !== r && random() > 0.3) other.inbox.push(update);
      // Deliver some messages out of order, some twice; the rest arrive late.
      for (const other of replicas) {
        if (random() < 0.5 && other.inbox.length) {
          const i = Math.floor(random() * other.inbox.length);
          const [m] = other.inbox.splice(i, 1);
          Y.applyUpdate(other.doc, m as Uint8Array, REMOTE);
          if (random() < 0.2) Y.applyUpdate(other.doc, m as Uint8Array, REMOTE);
          // A peer's view mid-delivery: graph, limits and the projection, not the writer's own checks.
          const check = validateBoard(other.doc, { assets: ASSETS, touched: new Set() });
          if (!check.ok) throw new Error(`seed ${seed}: merged state refused: ${check.reason}`);
        }
      }
    }
    // Everything arrives in the end, newest first; cleanup may emit more, so until nothing new appears.
    for (let round = 0, seen = -1; round < 5 && seen !== log.length; round++) {
      seen = log.length;
      for (const r of replicas) for (const m of [...log].reverse()) Y.applyUpdate(r.doc, m, REMOTE);
    }
    const hashes = replicas.map((r) => boardHash(yToBoard(r.doc)));
    expect(new Set(hashes).size, `seed ${seed}`).toBe(1);
    for (const r of replicas) {
      const check = validateBoard(r.doc, { assets: ASSETS });
      if (!check.ok) throw new Error(`seed ${seed}: ${check.reason}`);
      expect(
        yToBoard(r.doc).objects.every((o) => Number.isFinite(o.pose.x) && Number.isFinite(o.pose.w)),
      ).toBe(true);
    }
    // The server's repair of the converged state is deterministic and idempotent.
    const fix = repairBoard(replicas[0]?.doc as Y.Doc);
    if (fix) for (const r of replicas.slice(1)) Y.applyUpdate(r.doc, fix, REMOTE);
    expect(repairBoard(replicas[0]?.doc as Y.Doc)).toBeNull();
    expect(new Set(replicas.map((r) => boardHash(yToBoard(r.doc)))).size).toBe(1);
  }
}, 60_000);
