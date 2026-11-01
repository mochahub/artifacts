import { expect, type Page, test } from "@playwright/test";
import { watchErrors } from "./helpers.ts";

const shot = async (page: Page, project: string, name: string) => {
  if (project === "iphone") await page.screenshot({ path: `../../docs/mocks/shots/${name}.png` });
  if (project === "desktop") await page.screenshot({ path: `../../docs/mocks/shots/desktop-${name}.png` });
};

/** Taps the canvas at the middle of a frame, as a pointer would. */
async function tapFrame(page: Page) {
  const box = await page
    .locator(".fr")
    .first()
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
  for (const type of ["pointerdown", "pointerup"]) {
    await page
      .locator(".cv")
      .dispatchEvent(type, { pointerId: 1, clientX: box.x, clientY: box.y, bubbles: true, isPrimary: true });
  }
}

test("pin a comment, read it, reply and resolve", async ({ page }, info) => {
  const errors = watchErrors(page);
  const text = `Move this up ${info.project.name}`;
  await page.goto("/camerabuddy/roadmap/mocks#frame=welcome");
  await expect(page.locator(".capsule b")).toHaveText("Welcome");
  await page.waitForTimeout(350);

  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Tap a spot to comment")).toBeVisible();
  await tapFrame(page);
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Comment")).toBeFocused();
  await expect(page.locator(".pin.draft")).toBeVisible();
  await sheet.getByLabel("Comment").fill(text);
  await shot(page, info.project.name, "02-3-comment");
  await sheet.getByRole("button", { name: "Post" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: text });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".crop")).toBeVisible();
  await expect
    .poll(() => dialog.locator(".crop").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await shot(page, info.project.name, "02-4-thread");

  await dialog.getByLabel("Reply").fill("Second thought");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("Second thought")).toBeVisible();
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(dialog.getByText("Resolved")).toBeVisible();
  await dialog.getByRole("button", { name: "Reopen" }).click();
  await expect(dialog.getByText("Resolved")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Comments" }).click();
  await expect(page.getByRole("dialog", { name: "Comments" }).getByText(text)).toBeVisible();
  expect(errors).toEqual([]);
});

test("the comment sheet sits on the keyboard, and a thread opens from ?c=", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "phone only");
  await page.goto("/camerabuddy/roadmap/mocks#frame=timer");
  await expect(page.locator(".capsule b")).toHaveText("Timer");
  await page.waitForTimeout(350);
  // A simulated keyboard: visualViewport shrinks by 336 pt, as on an iPhone.
  await page.evaluate(() => {
    const viewport = window.visualViewport as VisualViewport;
    Object.defineProperty(viewport, "height", { get: () => innerHeight - 336 });
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await tapFrame(page);
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await expect(sheet).toBeVisible();
  await expect
    .poll(() => sheet.evaluate((el) => el.getBoundingClientRect().bottom))
    .toBeLessThanOrEqual(852 - 336);
  await sheet.getByRole("button", { name: "Close" }).click();
});

test("comment on a passage: select text, then the quote travels and highlights", async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto(`/camerabuddy/roadmap/research-0${info.project.name === "iphone" ? 3 : 4}`);
  const paragraph = page.locator('[data-block="findings/p1"]');
  await expect(paragraph).toBeVisible();
  await paragraph.evaluate((el) => {
    const node = el.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 4);
    range.setEnd(node, 17);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator(".selbtn").click();
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await expect(sheet.locator(".quote")).toHaveText("first finding");
  await sheet.getByLabel("Comment").fill(`Source? ${info.project.name}`);
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("mark.hl").first()).toHaveText("first finding");
  await shot(page, info.project.name, "03-4-quote");
  await page.locator(".mm").first().click();
  await expect(page.getByRole("dialog").locator(".quote")).toHaveText("first finding");
  expect(errors).toEqual([]);
});

test("comment on a block: tap Comment, then a paragraph", async ({ page }, info) => {
  await page.goto("/camerabuddy/roadmap/research-02");
  await expect(page.locator('[data-block="findings/p2"]')).toBeVisible();
  await page.locator(".vbar").getByRole("button", { name: "Comment", exact: true }).click();
  await page.locator('[data-block="findings/p2"]').click();
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await sheet.getByLabel("Comment").fill(`Whole paragraph ${info.project.name}`);
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(page.locator('[data-block="findings/p2"] .mm').first()).toBeVisible();
});

test("request changes, and the artifact says so", async ({ page }, info) => {
  await page.goto("/camerabuddy/roadmap");
  await page.getByRole("button", { name: "Approve or request changes" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Request changes" }).first().click();
  await sheet.getByLabel("Note").fill(`Tighten it ${info.project.name}`);
  await expect(sheet.getByText("artifacts status")).toBeVisible();
  await shot(page, info.project.name, "05-3-decide");
  await sheet.getByRole("button", { name: "Request changes" }).last().click();
  await expect(page.getByText(`Tighten it ${info.project.name}`)).toBeVisible();
  await expect(page.getByText(/^With .*'s Claude$/)).toBeVisible();
});
