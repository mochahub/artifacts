import { describe, expect, test } from "bun:test";
import { docToY, FRAGMENT, fixIds, topBlocks } from "@artifacts/doc/ydoc";
import * as Y from "yjs";

/**
 * 13, "Two-writer convergence", at the CRDT: clients and the server's operations in random order,
 * with dropped and reordered messages, converge and keep every id. Seeded, 200 runs.
 */

const para = (id: string, text: string) => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text, marks: [{ type: "author", attrs: { a: "a1", t: 1 } }] }],
});
const IDS = ["~aaaaaaaaaa", "~bbbbbbbbbb", "~cccccccccc", "~dddddddddd"];
const seedDoc = () => docToY({ type: "doc", content: IDS.map((id, i) => para(id, `Block ${i} text.`)) });

const textOf = (ydoc: Y.Doc, index: number) => {
  const block = topBlocks(ydoc)[index]?.el as Y.XmlElement;
  const delta = (block.get(0) as Y.XmlText).toDelta() as { insert: string }[];
  return delta.map((op) => op.insert).join("");
};

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** The server's replace without a held block: a character diff applied inside the block's text. */
function diffReplace(ydoc: Y.Doc, index: number, next: string, author: string) {
  const el = topBlocks(ydoc)[index]?.el as Y.XmlElement;
  const ytext = el.get(0) as Y.XmlText;
  const old = ytext.toString().length
    ? (ytext.toDelta() as { insert: string }[]).map((op) => op.insert).join("")
    : "";
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  ydoc.transact(() => {
    ytext.delete(start, old.length - start - end);
    ytext.insert(start, next.slice(start, next.length - end), { author: { a: author, t: 2 } });
  }, "server");
}

describe("convergence", () => {
  test("a person typing in block B while an agent replaces B by diff: both survive", () => {
    const server = seedDoc();
    const person = new Y.Doc();
    Y.applyUpdate(person, Y.encodeStateAsUpdate(server));
    // The person types at the end of B; the update hasn't reached the server yet.
    const before = Y.encodeStateVector(person);
    const block = topBlocks(person)[1]?.el as Y.XmlElement;
    (block.get(0) as Y.XmlText).insert(textOf(person, 1).length, " Typed by Sam.", {
      author: { a: "a2", t: 2 },
    });
    const typed = Y.encodeStateAsUpdate(person, before);
    const serverBefore = Y.encodeStateVector(server);
    diffReplace(server, 1, "Block 1 rewritten text.", "a3");
    const op = Y.encodeStateAsUpdate(server, serverBefore);
    Y.applyUpdate(server, typed);
    Y.applyUpdate(person, op);
    expect(textOf(server, 1)).toBe(textOf(person, 1));
    expect(textOf(server, 1)).toContain("rewritten");
    expect(textOf(server, 1)).toContain("Typed by Sam.");
    expect(topBlocks(server)[1]?.id).toBe(IDS[1]);
  });

  test("three writers and the server, 200 seeded runs with dropped and reordered messages", () => {
    for (let run = 0; run < 200; run++) {
      const random = rng(run + 1);
      const server = seedDoc();
      const clients = [0, 1, 2].map(() => {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
        return doc;
      });
      const inbox: { to: Y.Doc; update: Uint8Array }[] = [];
      const all = [server, ...clients];
      for (const doc of all)
        doc.on("update", (update: Uint8Array, origin: unknown) => {
          if (origin === "net") return;
          for (const other of all) if (other !== doc) inbox.push({ to: other, update });
        });
      for (let step = 0; step < 25; step++) {
        const roll = random();
        if (roll < 0.6) {
          const doc = clients[Math.floor(random() * 3)] as Y.Doc;
          const index = Math.floor(random() * IDS.length);
          const ytext = topBlocks(doc)[index]?.el.get(0) as Y.XmlText;
          const at = Math.floor(random() * (ytext.length + 1));
          if (random() < 0.8)
            ytext.insert(at, "xyz"[step % 3] as string, { author: { a: `a${step % 3}`, t: 3 } });
          else if (ytext.length > 1) ytext.delete(Math.min(at, ytext.length - 1), 1);
        } else if (roll < 0.75) {
          diffReplace(server, Math.floor(random() * IDS.length), `Server pass ${step}.`, "a9");
        } else if (roll < 0.85) {
          // An insert by operation: a new block with a server-minted id.
          const el = new Y.XmlElement("paragraph");
          el.setAttribute("id", `~s${String(run).padStart(4, "0")}${String(step).padStart(5, "0")}`);
          el.insert(0, [new Y.XmlText("Inserted.")]);
          server.transact(
            () => server.getXmlFragment(FRAGMENT).insert(Math.floor(random() * 3), [el]),
            "server",
          );
        }
        // Deliver some messages, out of order; drop a few (a resync below recovers them).
        for (let n = Math.floor(random() * inbox.length); n > 0; n--) {
          const at = Math.floor(random() * inbox.length);
          const [message] = inbox.splice(at, 1);
          if (message && random() > 0.1) Y.applyUpdate(message.to, message.update, "net");
        }
      }
      // Reconnect: every pair syncs by state vector, as step 1 and step 2 do.
      for (const doc of all)
        for (const other of all)
          if (doc !== other)
            Y.applyUpdate(other, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other)), "net");
      fixIds(server);
      for (const client of clients)
        Y.applyUpdate(client, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)), "net");
      const expected = JSON.stringify(server.getXmlFragment(FRAGMENT).toJSON());
      for (const client of clients)
        expect(JSON.stringify(client.getXmlFragment(FRAGMENT).toJSON())).toBe(expected);
      const ids = topBlocks(server).map((block) => block.id);
      for (const id of IDS) expect(ids).toContain(id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
