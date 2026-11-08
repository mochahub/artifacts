import type { Author } from "@artifacts/schema";
import type { BoardObject, BoardSnapshot } from "@artifacts/schema/boards";
import { expect, type Page } from "@playwright/test";
import { auth } from "./helpers.ts";
import { BASE_URL } from "./stack.ts";

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

/** Every fixture owns a real wiki, checkpoint and persisted draft. No HTTP or socket interception. */
export class BoardFixture {
  id = "";
  url = "";
  page!: Page;
  ids = new Map<string, string>();
  constructor(readonly snapshot: BoardSnapshot) {}
  async board(): Promise<{ objects: BoardObject[] }> {
    const response = await this.page.request.get(`/api/artifacts/${this.id}/board/objects?draft=1`);
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json();
    return { objects: body.objects.map((o: { object: BoardObject }) => o.object) };
  }
  async object(id: string) {
    return (await this.board()).objects.find((o: BoardObject) => o.id === (this.ids.get(id) ?? id)) ?? null;
  }
}
export async function seedBoard(page: Page, { relay }: { relay: BoardFixture }) {
  relay.page = page;
  // The board-only runner serializes this shared account. Reserve time for setup plus
  // the test's own edits within its real 60/minute quota; never retry a failed mutation.
  if (process.env.E2E_BOARDS_ONLY) await new Promise((resolve) => setTimeout(resolve, 3_000));
  const project = `board-${crypto.randomUUID().slice(0, 8)}`;
  const post = async (url: string, data: unknown, agent = false) => {
    const response = await page.request.post(url, {
      data,
      headers: { Origin: BASE_URL, ...(agent ? auth() : {}) },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await post("/api/wikis", { slug: project, name: "Board tests", onlyMe: true });
  await post("/api/boards", {
    project,
    slug: "checkout",
    title: "Checkout flow",
    summary: "A sketch and its mocks.",
  });
  const artifact = await (await page.request.get(`/api/artifacts/by-slug/${project}/checkout`)).json();
  relay.id = artifact.id;
  relay.url = `/${project}/checkout/board`;
  const state = await (await page.request.get(`/api/artifacts/${relay.id}/board/objects?draft=1`)).json();
  const refs = new Map(relay.snapshot.objects.map((o, i) => [o.id, `$o${i}`]));
  const ops = relay.snapshot.objects.map((o) => {
    if (o.kind === "connector")
      return {
        op: "connect",
        ref: refs.get(o.id),
        label: o.label,
        style: o.style,
        ...o.data,
        start: {
          ...o.data.start,
          binding: o.data.start.binding
            ? { ...o.data.start.binding, object: refs.get(o.data.start.binding.object) }
            : null,
        },
        end: {
          ...o.data.end,
          binding: o.data.end.binding
            ? { ...o.data.end.binding, object: refs.get(o.data.end.binding.object) }
            : null,
        },
      };
    const { id, order, attribution, ...object } = o;
    return { op: "add", ref: refs.get(id), object };
  });
  const result = await post(`/api/artifacts/${relay.id}/board/ops`, {
    epoch: state.epoch,
    bases: {},
    requestId: crypto.randomUUID(),
    ops,
  });
  expect(result.outcome).toBe("applied");
  for (const [id, ref] of refs) relay.ids.set(id, result.ids[ref]);
  await post(`/api/artifacts/${relay.id}/board/checkpoint`, { epoch: state.epoch });
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
