import { boardToY, yToBoard } from "@artifacts/doc/board";
import {
  awarenessMessage,
  controlMessage,
  readMessage,
  SYNC_STEP,
  savedMessage,
  syncStep2,
  syncUpdate,
} from "@artifacts/doc/sync";
import type { Author, Run, Thread } from "@artifacts/schema";
import type {
  BoardObject,
  BoardSnapshot,
  BoardState,
  BoardSuggestion,
  BoardSuggestionPreview,
} from "@artifacts/schema/boards";
import type { Page, WebSocketRoute } from "@playwright/test";
import { applyUpdate, type Doc } from "yjs";

/**
 * The board screens against answers of our own (as editing.e2e.ts does for articles): the version's
 * native marker, BoardState, the checkpoint snapshot, suggestions, and a sync relay that speaks the real
 * socket protocol (`@artifacts/doc/sync`) over Playwright's WebSocket routing, so two pages edit one
 * Y.Doc. The board server routes are other workers' in this phase; these tests cover the viewer.
 */

export const T0 = "2026-11-07T09:00:00.000Z";
export const PERSON: Author = {
  key: "a1",
  kind: "person",
  name: "Zahin",
  agent: null,
  for: null,
  sources: [],
};
export const AGENT: Author = {
  key: "a2",
  kind: "agent",
  name: "Claude Code",
  agent: "Claude Code",
  for: "Zahin",
  sources: [],
};
const by = (a: string, t = T0) => ({ a, t });
const attribution = (a: string, text = "", t = T0) => ({
  created: by(a, t),
  fields: {
    pose: by(a, t),
    parent: by(a, t),
    order: by(a, t),
    style: by(a, t),
    label: by(a, t),
    data: by(a, t),
  },
  text: text ? [{ s: 0, e: text.length, a, t }] : [],
});
const style = (over: Partial<BoardObject["style"]> = {}): BoardObject["style"] => ({
  fill: "transparent",
  stroke: "#242424",
  strokeWidth: 2,
  opacity: 1,
  fontSize: 20,
  align: "left",
  ...over,
});
const pose = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, angle: 0 });

export const IDS = {
  title: "~title00001",
  guests: "~guests0001",
  apple: "~apple00001",
  cart: "~cart000001",
  pay: "~pay0000001",
  done: "~done000001",
  cartPay: "~arrow00001",
  payDone: "~arrow00002",
  circle: "~circle0001",
};

/** "Checkout, first pass" from the design board: stickies, three shapes, two bound arrows, a ring. */
export function checkout(): BoardSnapshot {
  const sticky = (id: string, x: number, text: string, fill: string, a = "a1"): BoardObject => ({
    id,
    kind: "sticky",
    pose: pose(x, 60, 140, 110),
    parent: null,
    order: `a${id === IDS.guests ? 1 : 2}`,
    label: "",
    style: style({ fill, fontSize: 15 }),
    attribution: attribution(a, text),
    text,
  });
  const shape = (
    id: string,
    x: number,
    text: string,
    shape: "rect" | "ellipse",
    order: string,
  ): BoardObject => ({
    id,
    kind: "shape",
    shape,
    pose: pose(x, 230, 84, 50),
    parent: null,
    order,
    label: "",
    style: style({ fill: "#ffffff", fontSize: 14, align: "center" }),
    attribution: attribution("a1", text),
    text,
  });
  const arrow = (id: string, from: string, to: string, order: string): BoardObject => ({
    id,
    kind: "connector",
    pose: pose(0, 0, 1, 1),
    parent: null,
    order,
    label: "",
    style: style(),
    attribution: attribution("a1"),
    data: {
      start: { point: { x: 0, y: 0 }, binding: { object: from, u: 1, v: 0.5 } },
      end: { point: { x: 0, y: 0 }, binding: { object: to, u: 0, v: 0.5 } },
      route: "straight",
      startArrow: false,
      endArrow: true,
    },
  });
  const ring = Array.from({ length: 24 }, (_, i) => {
    const t = (i / 23) * Math.PI * 2.1;
    return { u: 0.5 + 0.48 * Math.cos(t), v: 0.5 + 0.46 * Math.sin(t), pressure: 0.5 };
  });
  return {
    schema: 1,
    page: "mocks",
    deleted: [],
    assets: [],
    objects: [
      {
        id: IDS.title,
        kind: "text",
        pose: pose(0, 0, 320, 36),
        parent: null,
        order: "a0",
        label: "",
        style: style({ fontSize: 24 }),
        attribution: attribution("a1", "Checkout, first pass"),
        text: "Checkout, first pass",
      },
      sticky(IDS.guests, 0, "Guests pay without an account", "#d9ead3"),
      sticky(IDS.apple, 170, "Apple Pay first on iPhone", "#f8d6c8"),
      shape(IDS.cart, 0, "Cart", "rect", "a3"),
      shape(IDS.pay, 120, "Pay", "rect", "a4"),
      shape(IDS.done, 240, "Done", "ellipse", "a5"),
      arrow(IDS.cartPay, IDS.cart, IDS.pay, "a6"),
      arrow(IDS.payDone, IDS.pay, IDS.done, "a7"),
      {
        id: IDS.circle,
        kind: "stroke",
        pose: pose(105, 215, 116, 82),
        parent: null,
        order: "a8",
        label: "",
        style: style({ strokeWidth: 3 }),
        attribution: attribution("a1"),
        points: ring,
      },
    ],
  } as BoardSnapshot;
}

export function boardState(over: Partial<BoardState> = {}): BoardState {
  return {
    editable: true,
    reason: null,
    canEdit: true,
    canAccept: true,
    canMaintain: true,
    version: 1,
    dirty: false,
    seq: 1,
    epoch: 1,
    updatedAt: T0,
    agentMaintained: false,
    agents: { edits: "suggestion", reason: "audience", text: "Agents' drawings arrive as suggestions." },
    audience: { kind: "team", label: "Design team" } as BoardState["audience"],
    present: [],
    openSuggestions: 0,
    runs: [],
    ...over,
  };
}

type Connection = { ws: WebSocketRoute; saved: number };

/** One shared draft, as the server's DocHub keeps it: updates relayed between pages, and `saved` acks. */
export class Relay {
  readonly doc: Doc;
  private readonly connections = new Set<Connection>();
  private next = 1;

  constructor(snapshot: BoardSnapshot) {
    this.doc = boardToY(snapshot);
  }

  board() {
    return yToBoard(this.doc);
  }

  object(id: string) {
    return this.board().objects.find((o) => o.id === id) ?? null;
  }

  attach(ws: WebSocketRoute, author = `a${this.next++ === 1 ? 1 : 3}`) {
    const conn: Connection = { ws, saved: 0 };
    this.connections.add(conn);
    const send = (bytes: Uint8Array) => ws.send(Buffer.from(bytes));
    ws.onMessage((message) => {
      const bytes = typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
      const incoming = readMessage(bytes);
      if (incoming.type === "sync") {
        if (incoming.step === SYNC_STEP.step1) send(syncStep2(this.doc, incoming.payload));
        else if (incoming.step === SYNC_STEP.step2 || incoming.step === SYNC_STEP.update) {
          applyUpdate(this.doc, incoming.payload);
          conn.saved += 1;
          send(savedMessage(conn.saved));
          for (const other of this.connections)
            if (other !== conn) other.ws.send(Buffer.from(syncUpdate(incoming.payload)));
        }
      } else if (incoming.type === "awareness") {
        for (const other of this.connections)
          if (other !== conn) other.ws.send(Buffer.from(awarenessMessage(incoming.update)));
      }
    });
    ws.onClose(() => this.connections.delete(conn));
    send(controlMessage({ t: "hello", author, epoch: 1, seq: 1, version: 1, canAccept: true }));
  }
}

export type Stubs = {
  state?: Partial<BoardState>;
  snapshot?: BoardSnapshot;
  suggestions?: BoardSuggestion[];
  previews?: Record<string, BoardSuggestionPreview>;
  threads?: Thread[];
  runs?: Run[];
  relay?: Relay;
  decided?: string[];
};

/** Makes the fixture's mocks page an editable wiki board with a native checkpoint. */
export async function mockBoard(page: Page, stubs: Stubs) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route(/\/api\/artifacts\/by-slug\/camerabuddy\/roadmap$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, projectKind: "wiki" } });
  });
  await page.route(/\/api\/artifacts\/[^/]+\/versions\/\d+$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const p of body.pages)
      if (p.key === "mocks") p.meta = { ...p.meta, board: { schema: 1, hash: "0".repeat(64) } };
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/artifacts\/[^/]+\/board$/, (route) =>
    route.fulfill(json(boardState({ runs: stubs.runs ?? [], ...stubs.state }))),
  );
  await page.route(/\/api\/artifacts\/[^/]+\/board\/snapshot/, (route) =>
    route.fulfill(
      json({
        version: 1,
        page: "mocks",
        hash: "0".repeat(64),
        snapshot: stubs.snapshot ?? checkout(),
        authors: [PERSON, AGENT],
        renders: null,
      }),
    ),
  );
  await page.route(/\/api\/artifacts\/[^/]+\/board\/suggestions/, (route) =>
    route.fulfill(json({ suggestions: stubs.suggestions ?? [], nextCursor: null })),
  );
  await page.route(/\/api\/artifacts\/[^/]+\/board\/objects/, (route) =>
    route.fulfill(json({ authors: [PERSON, AGENT] })),
  );
  await page.route(/\/api\/board-suggestions\/([^/]+)\/preview/, (route) => {
    const id = route
      .request()
      .url()
      .match(/board-suggestions\/([^/]+)\//)?.[1] as string;
    return route.fulfill(
      json(stubs.previews?.[id] ?? { id, epoch: 1, seq: 1, objects: [], deleted: [], nextCursor: null }),
    );
  });
  await page.route(/\/api\/board-suggestions\/([^/]+)\/(accept|reject)$/, (route) => {
    const [, id, verb] = route
      .request()
      .url()
      .match(/board-suggestions\/([^/]+)\/(accept|reject)$/) as string[];
    stubs.decided?.push(`${verb}:${id}`);
    return route.fulfill(json({ status: verb === "accept" ? "accepted" : "rejected", seq: 2 }));
  });
  await page.route(/\/api\/runs\/[^/]+\/(accept|reject|cancel)$/, (route) => {
    stubs.decided?.push(route.request().url().split("/").slice(-2).join(":"));
    return route.fulfill(json(stubs.runs?.[0] ?? {}));
  });
  if (stubs.threads)
    await page.route(/\/api\/artifacts\/[^/]+\/threads$/, (route) => route.fulfill(json(stubs.threads)));
  if (stubs.relay) {
    const relay = stubs.relay;
    await page.routeWebSocket(/\/doc\/sync/, (ws) => relay.attach(ws));
  }
}

/** The world transform the engine writes for tests. */
export const view = (page: Page) =>
  page.locator(".cv .world").evaluate((el) => ({
    x: Number((el as HTMLElement).dataset.x),
    y: Number((el as HTMLElement).dataset.y),
    s: Number((el as HTMLElement).dataset.s),
  }));

/** A synthetic pointer on the board: pen, touch or mouse, with its own id. */
export const firePointer = (
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
  pointerType: "pen" | "touch" | "mouse",
  pointerId: number,
) =>
  page.locator(".cv").evaluate(
    (el, init) => {
      el.dispatchEvent(
        new PointerEvent(init.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: init.x,
          clientY: init.y,
          pointerId: init.pointerId,
          pointerType: init.pointerType,
          isPrimary: init.pointerId === 1,
          pressure: init.type === "pointerup" ? 0 : 0.5,
          buttons: init.type === "pointerup" ? 0 : 1,
        }),
      );
    },
    { type, x, y, pointerType, pointerId },
  );

/** A board point on screen, from the engine's transform. */
export async function screenOf(page: Page, wx: number, wy: number) {
  const v = await view(page);
  const box = (await page.locator(".cv").boundingBox()) as { x: number; y: number };
  return { x: box.x + v.x + wx * v.s, y: box.y + v.y + wy * v.s };
}
