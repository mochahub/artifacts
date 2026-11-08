import type { BoardObject } from "@artifacts/schema/boards";
import { expect, type Page, test } from "@playwright/test";
import { BoardFixture, checkout, firePointer, IDS, screenOf, seedBoard } from "./boards-real.ts";
import { auth, settle, shot, watchErrors } from "./helpers.ts";
import { BASE_URL } from "./stack.ts";

// Exercise server checkpoints and persisted drafts without service worker caching.
test.use({ serviceWorkers: "block" });

async function openBoard(page: Page, stubs: { relay: BoardFixture }) {
  await seedBoard(page, stubs);
  await page.goto(stubs.relay.url);
  await expect(page.locator(".cv.board .bo").first()).toBeVisible();
}

async function edit(page: Page) {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".bed .cv.board[data-ready='1']")).toBeVisible({ timeout: 15_000 });
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
  const relay = new BoardFixture(checkout());
  await openBoard(page, { relay });
  await expect(page.locator(`.bo[data-id="${relay.ids.get(IDS.guests)}"]`)).toContainText(
    "Guests pay without an account",
  );
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
  const relay = new BoardFixture(checkout());
  await openBoard(page, { relay });
  await edit(page);
  const before = (await relay.board()).objects.length;

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
  const typed = async () =>
    (await relay.board()).objects.find((o) => o.kind === "sticky" && o.text === "Card declined: say why");
  await expect.poll(async () => !!(await typed())).toBe(true);
  expect((await relay.board()).objects.length).toBe(before + 1);
  const sticky = (await typed()) as BoardObject;
  expect(sticky.attribution.created.a).toBeTruthy();

  // Shape beside it.
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  const shapeSpot = await screenOf(page, 380, 420);
  await firePointer(page, "pointerdown", shapeSpot.x, shapeSpot.y, kind(), 1);
  await firePointer(page, "pointerup", shapeSpot.x, shapeSpot.y, kind(), 1);
  await page.getByRole("textbox", { name: "Text" }).fill("Retry");
  await page.getByRole("textbox", { name: "Text" }).blur();
  await expect
    .poll(async () => (await relay.board()).objects.some((o) => o.kind === "shape" && o.text === "Retry"))
    .toBe(true);
  const shape = (await relay.board()).objects.find(
    (o) => o.kind === "shape" && o.text === "Retry",
  ) as BoardObject;
  await page.locator(".bed .cv").focus();
  await page.keyboard.press("0");
  await settle(page);
  await shot(page, "18-2-board-select");

  // Arrow: from the sticky's right dot to the shape's left dot; it snaps and binds both ends.
  await page.getByRole("button", { name: "Arrow", exact: true }).click();
  const from = await screenOf(page, sticky.pose.x + sticky.pose.w, sticky.pose.y + sticky.pose.h / 2);
  const to = await screenOf(page, shape.pose.x + 4, shape.pose.y + shape.pose.h / 2);
  await drag(page, from, to, kind());
  await expect
    .poll(async () => (await relay.board()).objects.filter((o) => o.kind === "connector").length)
    .toBe(3);
  const arrow = (await relay.board()).objects.find(
    (o) => o.kind === "connector" && o.data.start.binding?.object === sticky.id,
  ) as Extract<BoardObject, { kind: "connector" }>;
  expect(arrow.data.end.binding?.object).toBe(shape.id);
  await page.locator(".bed .cv").focus();
  await page.keyboard.press("0");
  await settle(page);
  await shot(page, "18-3-board-arrow");

  // Move the shape: the arrow's end follows, its data untouched.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const arrowBefore = await rectOf(page, arrow.id);
  const grab = await screenOf(page, shape.pose.x + shape.pose.w / 2, shape.pose.y + shape.pose.h / 2);
  const dropAt = await screenOf(page, shape.pose.x + shape.pose.w / 2, shape.pose.y + shape.pose.h / 2 + 120);
  await drag(page, grab, dropAt, kind());
  await expect.poll(async () => (await relay.object(shape.id))?.pose.y).toBeGreaterThan(shape.pose.y + 100);
  await expect
    .poll(async () => (await rectOf(page, arrow.id)).height)
    .toBeGreaterThan(arrowBefore.height + 60);
  const after = (await relay.object(arrow.id)) as typeof arrow;
  expect(after.data).toEqual(arrow.data);
});

test("a second writer at the same time: nothing is lost", async ({ browser }) => {
  const relay = new BoardFixture(checkout());
  const context = await browser.newContext({ ...test.info().project.use, serviceWorkers: "block" });
  const [one, two] = [await context.newPage(), await context.newPage()];
  await seedBoard(one, { relay });
  for (const page of [one, two]) {
    await page.goto(relay.url);
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
  await expect
    .poll(async () => (await relay.board()).objects.filter((o) => o.kind === "sticky").length)
    .toBe(4);
  for (const page of [one, two]) {
    await expect(page.locator(".bed .bo.k-sticky")).toHaveCount(4);
    await expect(page.locator(".bed .bo.k-sticky", { hasText: "From one" })).toBeVisible();
    await expect(page.locator(".bed .bo.k-sticky", { hasText: "From two" })).toBeVisible();
  }
  await context.close();
});

test("Pair ghosts fit on screen and decisions persist on the server", async ({ page }) => {
  const relay = new BoardFixture(checkout());
  await openBoard(page, { relay });
  await edit(page);
  await page.getByRole("button", { name: "Pair", exact: true }).first().click();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/artifacts/${relay.id}/board`)).json()).agents.edits,
    )
    .toBe("suggestion");
  const current = await (await page.request.get(`/api/artifacts/${relay.id}/board/objects?draft=1`)).json();
  const response = await page.request.post(`/api/artifacts/${relay.id}/board/ops`, {
    headers: auth(),
    data: {
      epoch: current.epoch,
      bases: {},
      requestId: crypto.randomUUID(),
      suggest: true,
      agent: "Claude Code",
      note: "Your flow has no way back from a declined card.",
      ops: [
        {
          op: "add",
          ref: "$retry",
          object: {
            kind: "sticky",
            text: "Retry",
            parent: null,
            label: "Retry",
            pose: { x: 390, y: 330, w: 150, h: 100, angle: 0 },
            style: checkout().objects[1]?.style,
          },
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result.outcome).toBe("suggested");
  const region = page.getByRole("region", { name: "Claude suggests" });
  await expect(region).toContainText("Your flow has no way back");
  await expect(page.locator(".ghosts .bo")).toHaveCount(1);
  expect(await relay.object(result.ids.$retry)).toBeNull();
  await page.locator(".bed .cv").focus();
  await page.keyboard.press("0");
  await settle(page);
  const ghost = await page.locator(".ghosts .bo").boundingBox();
  if (!ghost) throw new Error("The suggestion has no visible bounds");
  expect(ghost.x).toBeGreaterThanOrEqual(0);
  expect(ghost.x + ghost.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await shot(page, "18-4-board-pair");
  await region.getByRole("button", { name: "Accept" }).click();
  await expect(region).toHaveCount(0);
  await expect.poll(async () => (await relay.object(result.ids.$retry))?.kind).toBe("sticky");
});

test("Delegate checkpoints and attribution come from the real run", async ({ page }) => {
  const relay = new BoardFixture(checkout());
  await openBoard(page, { relay });
  await edit(page);
  await page.getByRole("button", { name: "Delegate", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/artifacts/${relay.id}/board`)).json()).agents.edits,
    )
    .toBe("direct");
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { headers: auth(), data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const run = await post(`/api/artifacts/${relay.id}/doc/runs`, {
    goal: "Turn this into mocks",
    agent: "Claude Code",
  });
  const current = await (await page.request.get(`/api/artifacts/${relay.id}/board/objects?draft=1`)).json();
  const result = await post(`/api/artifacts/${relay.id}/board/ops`, {
    epoch: current.epoch,
    bases: {},
    requestId: crypto.randomUUID(),
    run: run.id,
    agent: "Claude Code",
    ops: [
      {
        op: "add",
        ref: "$mock",
        object: {
          kind: "shape",
          shape: "rect",
          text: "Cart mock",
          parent: null,
          label: "Cart mock",
          pose: { x: 0, y: 330, w: 120, h: 200, angle: 0 },
          style: checkout().objects[3]?.style,
        },
      },
    ],
  });
  expect(result.outcome).toBe("applied");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await post(`/api/runs/${run.id}/finish`, { message: "A checkout mock beside the sketch." });
  await page.reload();
  await edit(page);
  const review = page.getByRole("region", { name: "Claude finished" });
  await expect(review).toBeVisible();
  await shot(page, "18-5-board-delegate-review");
  await review.getByRole("button", { name: /Keep/ }).click();
  await expect(review).toHaveCount(0);
  await page.getByRole("button", { name: "Show who made each object" }).click();
  await expect(page.locator(`.bo[data-id="${result.ids.$mock}"] .bo-who.agent`)).toContainText("Claude");
  await shot(page, "18-6-board-who");
});

test("object comment pins follow a checkpointed move", async ({ page }) => {
  const relay = new BoardFixture(checkout());
  await openBoard(page, { relay });
  const checkpoint = await (await page.request.get(`/api/artifacts/${relay.id}/board/snapshot`)).json();
  const id = relay.ids.get(IDS.apple) as string;
  const response = await page.request.post(`/api/artifacts/${relay.id}/threads`, {
    headers: { Origin: BASE_URL },
    data: {
      pageKey: "board",
      version: checkpoint.version,
      body: "Keep Apple Pay first",
      anchor: { type: "object", object: id, u: 0.9, v: 0.1, checkpoint: checkpoint.version },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.reload();
  await expect(page.locator(".cv.board .pin").first()).toBeVisible();
  const before = await page.locator(".cv.board .pin").first().boundingBox();
  await shot(page, "18-8-board-comment-before");
  await edit(page);
  await page.getByRole("button", { name: "More tools" }).click();
  await page.getByRole("button", { name: /^Objects/ }).click();
  await page
    .getByRole("list", { name: "Objects on this board" })
    .getByRole("button", { name: /Apple Pay/ })
    .click();
  const x = page.getByRole("spinbutton", { name: "X" });
  await x.fill("220");
  await x.press("Enter");
  await expect.poll(async () => (await relay.object(id))?.pose.x).toBe(220);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const draft = await (await page.request.get(`/api/artifacts/${relay.id}/board/objects?draft=1`)).json();
  const saved = await page.request.post(`/api/artifacts/${relay.id}/board/checkpoint`, {
    headers: { Origin: BASE_URL },
    data: { epoch: draft.epoch },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.reload();
  const pin = page.locator(".cv.board .pin").first();
  await expect(pin).toBeVisible();
  await settle(page);
  expect((await pin.boundingBox())?.x).not.toBe(before?.x);
  await shot(page, "18-9-board-comment-after");
});

test("a signed-in commenter sees the checkpoint and cannot edit", async ({ page, browser }) => {
  const relay = new BoardFixture(checkout());
  await openBoard(page, { relay });
  const email = `commenter-${crypto.randomUUID()}@example.com`;
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { headers: { Origin: BASE_URL }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const invite = await post("/api/invites", { email, role: "reviewer" });
  const context = await browser.newContext({
    ...test.info().project.use,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const other = await context.newPage();
    const accepted = await other.request.post(
      `/api/invites/${new URL(invite.url).pathname.split("/").pop()}/accept`,
      {
        headers: { Origin: BASE_URL },
        data: { name: "Maya", password: "a perfectly long password" },
      },
    );
    expect(accepted.ok(), await accepted.text()).toBe(true);
    await post(`/api/artifacts/${relay.id}/access`, { email, permission: "comment" });
    await other.goto(relay.url);
    await expect(other.locator(".cv.board .bo").first()).toBeVisible();
    await expect(other.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(other.getByRole("note")).toContainText("You can read and comment");
    await expect(other.getByRole("button", { name: "Ask to edit" })).toBeVisible();
    await shot(other, "18-7-board-readonly");
    const state = await (await other.request.get(`/api/artifacts/${relay.id}/board`)).json();
    expect(state).toMatchObject({ canEdit: false, seq: 0, epoch: 0, present: [], runs: [] });
  } finally {
    await context.close();
  }
});
