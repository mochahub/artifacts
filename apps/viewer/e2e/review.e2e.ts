import { expect, type Page, test } from "@playwright/test";
import { here, settle, shot, tap, token, watchErrors } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

const desktop = { desktop: true };

/** Taps the canvas at the middle of the first frame, as a pointer would. */
async function tapFrame(page: Page) {
  const frame = (await page.getByRole("img").first().boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  await tap(page, frame.x + frame.width / 2, frame.y + frame.height / 2);
}

/** Opens the welcome frame and waits for the canvas to finish moving there. */
async function openWelcome(page: Page) {
  await page.goto("/camerabuddy/roadmap/mocks#frame=welcome");
  await expect(here(page, "Welcome")).toBeVisible();
  await settle(page);
}

/** Tests run in parallel, so each one that needs an open thread pins its own. */
async function pinComment(page: Page, text: string) {
  await openWelcome(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await tapFrame(page);
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await sheet.getByLabel("Comment").fill(text);
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: text })).toBeVisible();
  await page.keyboard.press("Escape");
}

test("pin a comment, read it, reply and resolve", async ({ page }, info) => {
  const errors = watchErrors(page);
  const text = `Move this up ${info.project.name}`;
  await openWelcome(page);

  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Tap a spot to comment")).toBeVisible();
  await tapFrame(page);
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Comment")).toBeFocused();
  await expect(page.locator(".pin.draft")).toBeVisible();
  // The toolbar steps aside, so its labels don't show through the sheet under Cancel and Post.
  await expect(page.locator(".vbar")).toBeHidden();
  await sheet.getByLabel("Comment").fill(text);
  await shot(page, "02-3-comment", desktop);
  await sheet.getByRole("button", { name: "Post" }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: text });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".vbar")).toBeVisible();
  // The same title as an article thread, with the frame underneath it.
  await expect(dialog).toHaveAccessibleName(/^Comment \d+$/);
  await expect(dialog.getByText("Welcome", { exact: true })).toBeVisible();
  const crop = dialog.getByRole("img", { name: "The area this comment points at" });
  await expect(crop).toBeVisible();
  await expect.poll(() => crop.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await shot(page, "02-4-thread", desktop);

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

test("everything in the comments sheet can be tapped", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "the sheet is phone only");
  await pinComment(page, "Tap around this");
  await page.getByRole("button", { name: "Comments" }).click();
  const sheet = page.getByRole("dialog", { name: "Comments" });
  await sheet.getByRole("button", { name: /^Fixed/ }).click({ timeout: 3000 });
  await expect(sheet.getByRole("button", { name: "Copy prompt for your agent" })).toHaveCount(0);
  await sheet.getByRole("button", { name: /^Open/ }).click({ timeout: 3000 });
  await sheet.getByRole("button", { name: "Close" }).click({ timeout: 3000 });
  await expect(sheet).toHaveCount(0);
});

test("copy the prompt for an agent from the comments", async ({ page }, info) => {
  await page.addInitScript(() => {
    const clip = { text: "" };
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          clip.text = text;
        },
      },
    });
    Object.assign(window, { clip });
  });
  const text = `Leave this out ${info.project.name}`;
  await pinComment(page, text);
  const phone = info.project.name === "iphone";
  if (phone) await page.getByRole("button", { name: "Comments" }).click();
  const where = phone
    ? page.getByRole("dialog", { name: "Comments" })
    : page.getByRole("complementary", { name: "Comments" });
  await where.getByRole("button", { name: "Copy prompt for your agent" }).click();
  await expect(where.getByRole("button", { name: "Copied. Paste it to your agent" })).toBeVisible();
  const copied = await page.evaluate(() => (window as unknown as { clip: { text: string } }).clip.text);
  expect(copied).toContain("Address the open comments on camerabuddy/roadmap");
  expect(copied).toContain(`${new URL(page.url()).origin}/camerabuddy/roadmap`);
  expect(copied).not.toContain(text);
});

test("if the copy fails, the prompt is there to select", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "phone only");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("refused")) },
    });
  });
  await pinComment(page, "Copy this by hand");
  await page.getByRole("button", { name: "Comments" }).click();
  const sheet = page.getByRole("dialog", { name: "Comments" });
  await sheet.getByRole("button", { name: "Copy prompt for your agent" }).click();
  await expect(sheet.getByText("Couldn't copy.")).toBeVisible();
  await expect(sheet.getByText("artifacts pull camerabuddy/roadmap")).toBeVisible();
});

test("the comment sheet sits on the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "phone only");
  await page.goto("/camerabuddy/roadmap/mocks#frame=timer");
  await expect(here(page, "Timer")).toBeVisible();
  await settle(page);
  // A simulated keyboard: visualViewport shrinks by 336 pt, as on an iPhone.
  const keyboard = 336;
  await page.evaluate((keyboard) => {
    const viewport = window.visualViewport as VisualViewport;
    Object.defineProperty(viewport, "height", { get: () => innerHeight - keyboard });
  }, keyboard);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await tapFrame(page);
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await expect(sheet).toBeVisible();
  await expect
    .poll(() => sheet.evaluate((el) => el.getBoundingClientRect().bottom))
    .toBeLessThanOrEqual((page.viewportSize() as { height: number }).height - keyboard);
  await sheet.getByRole("button", { name: "Close" }).click();
});

test("comment on a passage: select text, then the quote travels and highlights", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  // Its own copy: the other run's highlight on the same words would be the first one here.
  const slug = `quote-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}/research-03`);
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
  await expect(page.locator("mark.hl")).toHaveText("first finding");
  await shot(page, "03-4-quote", desktop);
  // The margin tab is whole on a phone: inside the gutter, not past the edge of the screen.
  const mark = paragraph.getByRole("button", { name: /^Comment \d+$/ });
  const tab = (await mark.boundingBox()) as { x: number; width: number };
  expect(tab.x).toBeGreaterThanOrEqual(0);
  expect(tab.x + tab.width).toBeLessThanOrEqual((page.viewportSize() as { width: number }).width);
  expect(tab.width).toBeGreaterThanOrEqual(24);
  await mark.click();
  const thread = page.getByRole("dialog");
  await expect(thread.locator(".quote")).toHaveText("first finding");
  await expect(thread).toHaveAccessibleName(/^Comment \d+$/);
  await expect(thread.getByText(/metering|peaking/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("comment on a whole paragraph: the selection ends in the next block", async ({ page }) => {
  await page.goto("/camerabuddy/roadmap/research-03");
  const paragraph = page.locator('[data-block="findings/p1"]');
  await expect(paragraph).toBeVisible();
  // What a triple-click leaves: from the paragraph's first word to offset 0 of the block after it.
  await paragraph.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild as Text, 0);
    range.setEnd(el.nextElementSibling as Element, 0);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator(".selbtn").click();
  await expect(page.getByRole("dialog", { name: "New comment" }).locator(".quote")).toHaveText(
    "The first finding is plain and short.",
  );
});

test("comment on a block: tap Comment, then a paragraph", async ({ page }, info) => {
  await page.goto("/camerabuddy/roadmap/research-02");
  await expect(page.locator('[data-block="findings/p2"]')).toBeVisible();
  await page.locator(".vbar").getByRole("button", { name: "Comment", exact: true }).click();
  await page.locator('[data-block="findings/p2"]').click();
  const sheet = page.getByRole("dialog", { name: "New comment" });
  await sheet.getByLabel("Comment").fill(`Whole paragraph ${info.project.name}`);
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(
    page
      .locator('[data-block="findings/p2"]')
      .getByRole("button", { name: /^Comment \d+$/ })
      .first(),
  ).toBeVisible();
});

test("request changes, and the artifact says so", async ({ page }, info) => {
  await page.goto("/camerabuddy/roadmap");
  await page.getByRole("button", { name: "Approve or request changes" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Request changes" }).first().click();
  await sheet.getByLabel("Note").fill(`Tighten it ${info.project.name}`);
  await expect(sheet.getByText("artifacts status")).toBeVisible();
  await shot(page, "05-3-decide", desktop);
  await sheet.getByRole("button", { name: "Request changes" }).last().click();
  const next = page.getByRole("dialog", { name: "Changes requested" });
  await expect(next.getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
  await next.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText(`Tighten it ${info.project.name}`)).toBeVisible();
  await expect(page.getByText(/^With .*'s Claude$/)).toBeVisible();
});
