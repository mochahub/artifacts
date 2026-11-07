import type { Thread } from "@artifacts/schema";
import type { BoardObject, BoardSuggestion } from "@artifacts/schema/boards";
import { expect, type Page, test } from "@playwright/test";
import {
  AGENT,
  checkout,
  firePointer,
  IDS,
  mockBoard,
  PERSON,
  Relay,
  type Stubs,
  screenOf,
  T0,
} from "./boards-mock.ts";
import { shot, watchErrors } from "./helpers.ts";

// Board answers are ours (boards-mock.ts); the service worker would answer before the routes do.
test.use({ serviceWorkers: "block" });

const URL = "/camerabuddy/roadmap/mocks";

async function openBoard(page: Page, stubs: Stubs) {
  await mockBoard(page, stubs);
  await page.goto(URL);
  await expect(page.locator(".cv.board .bo").first()).toBeVisible();
}

async function edit(page: Page) {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".bed .cv.board[data-ready='1']")).toBeVisible();
}

/** Where an object is drawn on screen now. */
const rectOf = (page: Page, id: string) =>
  page.locator(`.bed .blayer:not(.ghosts) .bo[data-id="${id}"]`).boundingBox() as Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;

/** A mouse or finger gesture on the board, by the device's own pointer type. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  type: "mouse" | "touch",
) {
  await firePointer(page, "pointerdown", from.x, from.y, type, 1);
  for (let i = 1; i <= 6; i++)
    await firePointer(
      page,
      "pointermove",
      from.x + ((to.x - from.x) * i) / 6,
      from.y + ((to.y - from.y) * i) / 6,
      type,
      1,
    );
  await firePointer(page, "pointerup", to.x, to.y, type, 1);
}
const kind = () => (test.info().project.use.hasTouch ? "touch" : "mouse");

test("reading a native board: drawn from its checkpoint, an Objects list, and no editor until Edit", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const editorFetched: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/(editor|provider|board-ids)-/.test(request.url())) editorFetched.push(request.url());
  });
  await openBoard(page, { relay: new Relay(checkout()) });
  await expect(page.locator(`.bo[data-id="${IDS.guests}"]`)).toContainText("Guests pay without an account");
  await expect(page.locator(".bo.k-connector")).toHaveCount(2);
  await shot(page, "18-1-board-read");
  await page.getByRole("button", { name: "Objects" }).click();
  const list = page.getByRole("list", { name: "Objects on this board" });
  await expect(list.getByRole("button")).toHaveCount(9);
  await expect(list).toContainText("from Shape: Cart to Shape: Pay");
  await page.keyboard.press("Escape");
  expect(editorFetched).toEqual([]);
  await edit(page);
  expect(editorFetched.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("sticky, shape and an arrow bound to both that follows a move", async ({ page }) => {
  const relay = new Relay(checkout());
  await openBoard(page, { relay });
  await edit(page);
  const before = relay.board().objects.length;

  // Sticky: one tap places it, it opens for typing, and the tool goes back to Select.
  await page.getByRole("button", { name: "Sticky", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sticky", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const spot = await screenOf(page, 120, 420);
  await firePointer(page, "pointerdown", spot.x, spot.y, kind(), 1);
  await firePointer(page, "pointerup", spot.x, spot.y, kind(), 1);
  const text = page.getByRole("textbox", { name: "Text" });
  await expect(text).toBeFocused();
  await text.fill("Card declined: say why");
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await text.blur();
  const typed = () =>
    relay.board().objects.find((o) => o.kind === "sticky" && o.text === "Card declined: say why");
  await expect.poll(() => !!typed()).toBe(true);
  expect(relay.board().objects.length).toBe(before + 1);
  const sticky = typed() as BoardObject;
  expect(sticky.attribution.created.a).toBe("a1");

  // Shape beside it.
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  const shapeSpot = await screenOf(page, 380, 420);
  await firePointer(page, "pointerdown", shapeSpot.x, shapeSpot.y, kind(), 1);
  await firePointer(page, "pointerup", shapeSpot.x, shapeSpot.y, kind(), 1);
  await page.getByRole("textbox", { name: "Text" }).fill("Retry");
  await page.getByRole("textbox", { name: "Text" }).blur();
  await expect
    .poll(() => relay.board().objects.some((o) => o.kind === "shape" && o.text === "Retry"))
    .toBe(true);
  const shape = relay.board().objects.find((o) => o.kind === "shape" && o.text === "Retry") as BoardObject;
  await shot(page, "18-2-board-select");

  // Arrow: from the sticky's right dot to the shape's left dot; it snaps and binds both ends.
  await page.getByRole("button", { name: "Arrow", exact: true }).click();
  const from = await screenOf(page, sticky.pose.x + sticky.pose.w, sticky.pose.y + sticky.pose.h / 2);
  const to = await screenOf(page, shape.pose.x + 4, shape.pose.y + shape.pose.h / 2);
  await drag(page, from, to, kind());
  await expect.poll(() => relay.board().objects.filter((o) => o.kind === "connector").length).toBe(3);
  const arrow = relay
    .board()
    .objects.find((o) => o.kind === "connector" && o.data.start.binding?.object === sticky.id) as Extract<
    BoardObject,
    { kind: "connector" }
  >;
  expect(arrow.data.end.binding?.object).toBe(shape.id);
  await shot(page, "18-3-board-arrow");

  // Move the shape: the arrow's end follows, its data untouched.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const arrowBefore = await rectOf(page, arrow.id);
  const grab = await screenOf(page, shape.pose.x + shape.pose.w / 2, shape.pose.y + shape.pose.h / 2);
  const dropAt = await screenOf(page, shape.pose.x + shape.pose.w / 2, shape.pose.y + shape.pose.h / 2 + 120);
  await drag(page, grab, dropAt, kind());
  await expect.poll(() => (relay.object(shape.id) as BoardObject).pose.y).toBeGreaterThan(shape.pose.y + 100);
  await expect
    .poll(async () => (await rectOf(page, arrow.id)).height)
    .toBeGreaterThan(arrowBefore.height + 60);
  const after = relay.object(arrow.id) as typeof arrow;
  expect(after.data).toEqual(arrow.data);
});

test("a second writer at the same time: nothing is lost", async ({ browser }) => {
  const relay = new Relay(checkout());
  const context = await browser.newContext({ ...test.info().project.use, serviceWorkers: "block" });
  const [one, two] = [await context.newPage(), await context.newPage()];
  for (const page of [one, two]) {
    await openBoard(page, { relay });
    await edit(page);
  }
  // Each adds a sticky at once, and one moves an existing object while the other types into it.
  await Promise.all(
    [one, two].map(async (page, i) => {
      await page.getByRole("button", { name: "Sticky", exact: true }).click();
      const at = await screenOf(page, 60 + i * 200, 520);
      await firePointer(page, "pointerdown", at.x, at.y, "mouse", 1);
      await firePointer(page, "pointerup", at.x, at.y, "mouse", 1);
      await page.getByRole("textbox", { name: "Text" }).fill(i === 0 ? "From one" : "From two");
      await page.getByRole("textbox", { name: "Text" }).blur();
    }),
  );
  await expect.poll(() => relay.board().objects.filter((o) => o.kind === "sticky").length).toBe(4);
  for (const page of [one, two]) {
    await expect(page.locator(".bed .bo.k-sticky")).toHaveCount(4);
    await expect(page.locator(".bed .bo.k-sticky", { hasText: "From one" })).toBeVisible();
    await expect(page.locator(".bed .bo.k-sticky", { hasText: "From two" })).toBeVisible();
  }
  await context.close();
});

const ghost = (
  id: string,
  note: string,
  object: BoardObject,
): { suggestion: BoardSuggestion; preview: Stubs["previews"] } => ({
  suggestion: {
    id,
    epoch: 1,
    request: { epoch: 1, requestId: id, bases: {}, ops: [{ op: "delete", object: IDS.circle }] },
    ids: {},
    status: "open",
    author: AGENT,
    note,
    sources: [],
    run: null,
    createdAt: T0,
    expiresAt: "2026-11-08T09:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
  },
  preview: {
    [id]: {
      id,
      epoch: 1,
      seq: 1,
      objects: [{ object, base: "0123456789ab" }],
      deleted: [],
      nextCursor: null,
    },
  },
});

test("Pair: Claude's suggestions are see-through ghosts, accepted or rejected", async ({ page }) => {
  const relay = new Relay(checkout());
  const card = {
    ...(checkout().objects.find((o) => o.id === IDS.apple) as BoardObject),
    id: "~ghost00001",
    pose: { x: 170, y: 330, w: 150, h: 100, angle: 0 },
    text: "Card declined: say why, keep the cart",
    style: { ...checkout().objects[1]?.style, fill: "#eadfcf" },
    attribution: {
      ...(checkout().objects[1] as BoardObject).attribution,
      text: [{ s: 0, e: 37, a: "a2", t: T0 }],
    },
  } as BoardObject;
  const a = ghost(
    "00000000-0000-4000-8000-0000000000a1",
    "Your flow has no way back from a declined card.",
    card,
  );
  const b = ghost("00000000-0000-4000-8000-0000000000a2", "Add a Retry button.", {
    ...card,
    id: "~ghost00002",
    pose: { ...card.pose, y: 470 },
    text: "Retry",
  } as BoardObject);
  const decided: string[] = [];
  await openBoard(page, {
    relay,
    suggestions: [a.suggestion, b.suggestion],
    previews: { ...a.preview, ...b.preview },
    decided,
  });
  await edit(page);
  await page.getByRole("button", { name: "Pair", exact: true }).first().click();
  const region = page.getByRole("region", { name: "Claude suggests" });
  await expect(region).toContainText("Your flow has no way back from a declined card.");
  await expect(region).toContainText("1 of 2");
  await expect(page.locator(".ghosts .bo")).toHaveCount(2);
  await expect(page.locator(".ghost-tag").first()).toHaveText("✎ Claude suggests");
  // Ghosts never become canonical until accepted.
  expect(relay.object("~ghost00001")).toBeNull();
  await shot(page, "18-4-board-pair");
  await region.getByRole("button", { name: "Accept" }).click();
  await expect(region).toContainText("Add a Retry button.");
  await region.getByRole("button", { name: "Reject" }).click();
  await expect(region).toHaveCount(0);
  expect(decided).toEqual([`accept:${a.suggestion.id}`, `reject:${b.suggestion.id}`]);
  await expect(page.locator(".bed .cv.board")).toBeFocused();
});

test("Delegate: the checkpoint review outlines what changed, and Keep acknowledges it", async ({ page }) => {
  const snapshot = checkout();
  const later = "2026-11-07T09:30:00.000Z";
  snapshot.objects.push({
    id: "~mock000001",
    kind: "shape",
    shape: "rect",
    pose: { x: 0, y: 330, w: 120, h: 200, angle: 0 },
    parent: null,
    order: "a9",
    label: "",
    style: { fill: "#ffffff", stroke: "#242424", strokeWidth: 2, opacity: 1, fontSize: 16, align: "center" },
    attribution: {
      created: { a: "a2", t: later },
      fields: Object.fromEntries(
        ["pose", "parent", "order", "style", "label", "data"].map((k) => [k, { a: "a2", t: later }]),
      ),
      text: [{ s: 0, e: 4, a: "a2", t: later }],
    },
    text: "Cart",
  } as BoardObject);
  const decided: string[] = [];
  await openBoard(page, {
    relay: new Relay(snapshot),
    snapshot,
    decided,
    runs: [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        status: "finished",
        edits: "direct",
        goal: "Turn this into mocks",
        agent: "Claude Code",
        startedBy: "Zahin",
        startedAt: "2026-11-07T09:10:00.000Z",
        expiresAt: "2026-11-07T10:10:00.000Z",
        finishedAt: later,
        version: 5,
        suggestions: 0,
      },
    ],
  });
  await edit(page);
  const review = page.getByRole("region", { name: "Claude finished" });
  await expect(review).toContainText("1 object changed");
  await expect(page.locator('.bo.review-changed[data-id="~mock000001"]')).toBeVisible();
  await shot(page, "18-5-board-delegate-review");
  await review.getByRole("button", { name: /Keep · v5/ }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Kept as v5" })).toBeVisible();
  // Keep is an acknowledgement: no new checkpoint and no run decision for a direct run.
  expect(decided).toEqual([]);
});

test("the eye shows who made each object: initials for people, the blue pencil for agents", async ({
  page,
}) => {
  const snapshot = checkout();
  const apple = snapshot.objects.find((o) => o.id === IDS.apple) as Extract<BoardObject, { kind: "sticky" }>;
  apple.attribution = {
    ...apple.attribution,
    created: { a: "a2", t: T0 },
    text: [{ s: 0, e: apple.text.length, a: "a2", t: T0 }],
  };
  await openBoard(page, { relay: new Relay(snapshot), snapshot });
  // An agent's words keep the pencil underline with the eye off.
  await expect(page.locator(`.bo[data-id="${IDS.apple}"] .pen`)).toHaveText(apple.text);
  await edit(page);
  await page.getByRole("button", { name: "Show who made each object" }).click();
  await expect(page.locator(`.bed .bo[data-id="${IDS.apple}"] .bo-who.agent`)).toHaveText("✎ Claude Code");
  await expect(page.locator(`.bed .bo[data-id="${IDS.guests}"] .bo-who`)).toContainText(PERSON.name);
  await shot(page, "18-6-board-who");
});

test("without edit access: read, comment and Ask to edit; no tools", async ({ page }) => {
  await openBoard(page, { state: { canEdit: false, canAccept: false, canMaintain: false } });
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("note")).toContainText("You can read and comment");
  await expect(page.getByRole("button", { name: "Ask to edit" })).toBeVisible();
  await shot(page, "18-7-board-readonly");
  await page.getByRole("button", { name: "Ask to edit" }).click();
  await expect(page.locator("textarea").first()).toBeVisible();
});

test("a comment pin follows its object when it moves", async ({ page }) => {
  const maya = { name: "Maya", kind: "person" as const, id: null };
  const thread = (n: number): Thread =>
    ({
      id: `00000000-0000-4000-8000-00000000c00${n}`,
      n,
      pageKey: "mocks",
      anchor: { type: "object", object: IDS.apple, u: 0.9, v: 0.1, checkpoint: 1 },
      anchorState: "ok",
      status: "open",
      createdVersion: 1,
      fixedVersion: null,
      author: maya,
      crop: null,
      comments: [
        {
          id: `00000000-0000-4000-8000-00000000d00${n}`,
          author: maya,
          agent: null,
          body: "Is Apple Pay first everywhere, or only on iPhone?",
          version: 1,
          marksFixed: false,
          createdAt: T0,
        },
      ],
      createdAt: T0,
      resolvedAt: null,
    }) as unknown as Thread;
  const stubs: Stubs = { threads: [thread(2)] };
  await openBoard(page, stubs);
  const pin = page.getByRole("button", { name: /Comment 2 on Sticky: Apple Pay/ });
  await expect(pin).toBeVisible();
  const near = async () => {
    const p = (await pin.boundingBox()) as { x: number; y: number; width: number; height: number };
    const o = (await page.locator(`.bo[data-id="${IDS.apple}"]`).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    // The pin's tail sits at (0.9, 0.1) on the sticky.
    return { dx: p.x - (o.x + o.width * 0.9), dy: p.y + p.height - (o.y + o.height * 0.1) };
  };
  const first = await near();
  expect(Math.abs(first.dx)).toBeLessThan(6);
  await shot(page, "18-8-board-comment-before");
  // The next checkpoint has the sticky moved and edited: the pin goes with it.
  const moved = checkout();
  const apple = moved.objects.find((o) => o.id === IDS.apple) as Extract<BoardObject, { kind: "sticky" }>;
  apple.pose = { ...apple.pose, x: 40, y: 360 };
  apple.text = "Apple Pay first on iPhone and iPad";
  await page.unroute(/\/api\/artifacts\/[^/]+\/board\/snapshot/);
  await page.route(/\/api\/artifacts\/[^/]+\/board\/snapshot/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        page: "mocks",
        hash: "1".repeat(64),
        snapshot: moved,
        authors: [PERSON, AGENT],
        renders: null,
      }),
    }),
  );
  await page.reload();
  await expect(page.locator(`.bo[data-id="${IDS.apple}"]`)).toContainText("iPad");
  const second = await near();
  expect(Math.abs(second.dx)).toBeLessThan(6);
  expect(Math.abs(second.dy - first.dy)).toBeLessThan(6);
  await shot(page, "18-9-board-comment-after");
});
