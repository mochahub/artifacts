import { expect, type Page, test } from "@playwright/test";
import { checkout, firePointer, mockBoard, Relay, screenOf, view } from "./boards-mock.ts";

/**
 * Who owns each pointer (14, "Viewer, gestures and accessibility"), with synthetic pen, touch and mouse
 * pointers on iPhone, iPad and desktop. Synthetic ids can't be captured, so these also exercise the
 * pointer-capture fallback: ownership comes from the arbiter, not from capture. Real Pencil pressure,
 * latency and palm rejection need a device and are reported separately.
 */
test.use({ serviceWorkers: "block" });

async function editor(page: Page, relay: Relay) {
  await mockBoard(page, { relay });
  await page.goto("/camerabuddy/roadmap/mocks");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".bed .cv.board[data-ready='1']")).toBeVisible();
  // An empty stretch of board, below the drawing, to draw and pan on.
  return screenOf(page, 160, 480);
}

const strokes = (relay: Relay) => relay.board().objects.filter((o) => o.kind === "stroke").length;

test("Apple Pencil draws whatever the tool; a palm neither draws, pans nor ends the stroke", async ({
  page,
}) => {
  const relay = new Relay(checkout());
  const at = await editor(page, relay);
  const before = strokes(relay);
  const start = await view(page);
  await firePointer(page, "pointerdown", at.x, at.y, "pen", 11);
  await firePointer(page, "pointermove", at.x + 10, at.y + 4, "pen", 11);
  // The palm lands, moves, lifts and is cancelled: none of it is the stroke's owner.
  await firePointer(page, "pointerdown", at.x + 120, at.y + 80, "touch", 21);
  await firePointer(page, "pointermove", at.x + 160, at.y + 120, "touch", 21);
  await firePointer(page, "pointerup", at.x + 160, at.y + 120, "touch", 21);
  await firePointer(page, "pointercancel", at.x + 160, at.y + 120, "touch", 21);
  // A second pen can't end it either.
  await firePointer(page, "pointerup", at.x, at.y, "pen", 12);
  expect(await view(page)).toEqual(start);
  await firePointer(page, "pointermove", at.x + 40, at.y + 20, "pen", 11);
  await firePointer(page, "pointermove", at.x + 70, at.y + 10, "pen", 11);
  expect(strokes(relay)).toBe(before);
  await firePointer(page, "pointerup", at.x + 70, at.y + 10, "pen", 11);
  await expect.poll(() => strokes(relay)).toBe(before + 1);
  const stroke = relay.board().objects.findLast((o) => o.kind === "stroke");
  expect(stroke?.kind === "stroke" && stroke.points.length).toBeGreaterThanOrEqual(4);

  // After the pen lifts, a finger navigates and draws nothing.
  const free = { x: at.x, y: at.y + 150 };
  await firePointer(page, "pointerdown", free.x, free.y, "touch", 31);
  for (let i = 1; i <= 5; i++)
    await firePointer(page, "pointermove", free.x + i * 12, free.y + i * 8, "touch", 31);
  await firePointer(page, "pointerup", free.x + 60, free.y + 40, "touch", 31);
  // It pans (and may coast on after, unless motion is reduced).
  await expect.poll(async () => (await view(page)).x - start.x).toBeGreaterThanOrEqual(59);
  expect(strokes(relay)).toBe(before + 1);
  // A pen tap leaves no stray dot.
  await firePointer(page, "pointerdown", at.x, at.y, "pen", 13);
  await firePointer(page, "pointerup", at.x, at.y, "pen", 13);
  expect(strokes(relay)).toBe(before + 1);
});

test("the Pen tool: one finger draws; a second finger cancels it and both pinch", async ({ page }) => {
  const relay = new Relay(checkout());
  const at = await editor(page, relay);
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await expect(page.getByText("One finger draws. Two fingers move.")).toBeVisible();
  const before = strokes(relay);
  await firePointer(page, "pointerdown", at.x, at.y, "touch", 1);
  for (let i = 1; i <= 5; i++)
    await firePointer(page, "pointermove", at.x + i * 10, at.y + i * 3, "touch", 1);
  await firePointer(page, "pointerup", at.x + 50, at.y + 15, "touch", 1);
  await expect.poll(() => strokes(relay)).toBe(before + 1);

  const start = await view(page);
  await firePointer(page, "pointerdown", at.x, at.y, "touch", 1);
  await firePointer(page, "pointermove", at.x + 8, at.y + 2, "touch", 1);
  await firePointer(page, "pointerdown", at.x + 100, at.y, "touch", 2);
  await expect(page.locator(".ink-live")).toHaveCount(0);
  for (let i = 1; i <= 4; i++) await firePointer(page, "pointermove", at.x + 100 + i * 20, at.y, "touch", 2);
  await firePointer(page, "pointerup", at.x + 180, at.y, "touch", 2);
  await firePointer(page, "pointerup", at.x + 8, at.y + 2, "touch", 1);
  expect((await view(page)).s).toBeGreaterThan(start.s);
  expect(strokes(relay)).toBe(before + 1);
});

test("Select: a mouse drags an object and pans empty space", async ({ page }) => {
  const relay = new Relay(checkout());
  const at = await editor(page, relay);
  const start = await view(page);
  await firePointer(page, "pointerdown", at.x, at.y, "mouse", 1);
  for (let i = 1; i <= 4; i++) await firePointer(page, "pointermove", at.x - i * 10, at.y, "mouse", 1);
  await firePointer(page, "pointerup", at.x - 40, at.y, "mouse", 1);
  await expect.poll(async () => (await view(page)).x - start.x).toBeLessThanOrEqual(-39);
  const sticky = page.locator('.bed .blayer .bo[data-id="~guests0001"]');
  const box = (await sticky.boundingBox()) as { x: number; y: number; width: number; height: number };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await firePointer(page, "pointerdown", x, y, "mouse", 1);
  for (let i = 1; i <= 4; i++) await firePointer(page, "pointermove", x, y + i * 10, "mouse", 1);
  await firePointer(page, "pointerup", x, y + 40, "mouse", 1);
  await expect.poll(() => relay.object("~guests0001")?.pose.y ?? 0).toBeGreaterThan(60 + 30 / start.s - 1);
});
