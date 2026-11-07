import { expect, type Page, test } from "@playwright/test";
import { checkout, IDS, mockBoard, Relay } from "./boards-mock.ts";

/** Keyboard, outline, labels and 44pt hit areas (14, "Viewer, gestures and accessibility"). */
test.use({ serviceWorkers: "block" });

async function editor(page: Page, relay: Relay) {
  await mockBoard(page, { relay });
  await page.goto("/camerabuddy/roadmap/mocks");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".bed .cv.board[data-ready='1']")).toBeVisible();
}

test("the keyboard and the Objects list do everything a drag does", async ({ page }) => {
  const relay = new Relay(checkout());
  await editor(page, relay);
  await expect(page.getByRole("application", { name: /Edit .* board/ })).toBeVisible();
  // Select from the outline, without a drag.
  await page.getByRole("button", { name: "More tools" }).click();
  await page.getByRole("button", { name: /^Objects/ }).click();
  await page
    .getByRole("list", { name: "Objects on this board" })
    .getByRole("button", { name: /Guests pay/ })
    .click();
  // Labelled inputs move it.
  const x = page.getByRole("spinbutton", { name: "X" });
  await x.fill("12");
  await x.press("Enter");
  await expect.poll(() => relay.object(IDS.guests)?.pose.x).toBe(12);
  await page.keyboard.press("Escape");
  await page.locator(".bed .cv").focus();
  // Arrows nudge by 1, Shift+arrows by 10.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => relay.object(IDS.guests)?.pose.x).toBe(13);
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => relay.object(IDS.guests)?.pose.y).toBe(70);
  // Delete removes it; undo brings back the same object.
  await page.keyboard.press("Delete");
  await expect.poll(() => relay.object(IDS.guests)).toBeNull();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => relay.object(IDS.guests)?.id).toBe(IDS.guests);
});

test("every tool, handle and selection control has a 44pt hit area; tools are labelled and the current one is marked", async ({
  page,
}) => {
  await editor(page, new Relay(checkout()));
  const tools = page.getByRole("toolbar", { name: "Tools" }).getByRole("button");
  await expect(tools).toHaveCount(7);
  for (const name of ["Select", "Pen", "Sticky", "Shape", "Text", "Arrow", "More tools"])
    await expect(
      page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "More tools" }).click();
  await page.getByRole("button", { name: /^Objects/ }).click();
  await page
    .getByRole("list", { name: "Objects on this board" })
    .getByRole("button", { name: /Apple Pay/ })
    .click();
  // Closed with its button: Escape would also let go of the selection.
  await page.getByRole("button", { name: "Close" }).click();
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".bed-tools .tb, .chrome .hd:not([hidden]), .ctx .cb")].map(
      (el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label"), w: r.width, h: r.height };
      },
    ),
  );
  expect(sizes.length).toBeGreaterThan(7 + 4);
  for (const size of sizes) {
    expect(size.w, size.label ?? "").toBeGreaterThanOrEqual(44);
    expect(size.h, size.label ?? "").toBeGreaterThanOrEqual(44);
  }
});

test("reduced motion: fitting jumps instead of flying", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockBoard(page, { relay: new Relay(checkout()) });
  await page.goto("/camerabuddy/roadmap/mocks");
  await expect(page.locator(".cv.board .bo").first()).toBeVisible();
  const world = page.locator(".cv .world");
  const before = await world.getAttribute("data-s");
  await page.keyboard.press("1");
  await page.keyboard.press("0");
  // No animation frames in between: the transform is final as soon as the key is handled.
  expect(await world.getAttribute("data-s")).toBe(before);
});
