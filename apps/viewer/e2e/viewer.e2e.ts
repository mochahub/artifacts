import { expect, type Page, test } from "@playwright/test";
import { watchErrors } from "./helpers.ts";

const shot = async (page: Page, project: string, name: string) => {
  if (project === "iphone") await page.screenshot({ path: `../../docs/mocks/shots/${name}.png` });
  if (project === "desktop") await page.screenshot({ path: `../../docs/mocks/shots/desktop-${name}.png` });
};

const transform = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __canvas: { x: number; y: number; s: number } }).__canvas;
    return { x: c.x, y: c.y, s: c.s };
  });

test("projects and a project list the fixture", async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByText("Camera Buddy roadmap").first()).toBeVisible();

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: /Camera Buddy/ }).last()).toBeVisible();
  await shot(page, info.project.name, "01-2-projects");

  await page.goto("/camerabuddy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Camera Buddy");
  await page.getByRole("button", { name: "Approved" }).click();
  await expect(page.getByText("Nothing here.")).toBeVisible();
  await page.getByRole("button", { name: "All" }).click();
  await page.getByLabel("Find in this project").fill("nope");
  await expect(page.getByText("Nothing here.")).toBeVisible();
  await page.getByLabel("Find in this project").fill("road");
  await expect(page.locator(".tile").getByText("Camera Buddy roadmap").first()).toBeVisible();
  await shot(page, info.project.name, "01-3-project");
  expect(errors).toEqual([]);
});

test("the artifact shows what changed, with the page switcher and version history", async ({
  page,
}, info) => {
  const errors = watchErrors(page);
  await page.goto("/camerabuddy/roadmap");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Camera Buddy roadmap");
  await expect(page.getByText("What changed in v2")).toBeVisible();
  await expect(page.getByText("9 pages")).toBeVisible();
  await shot(page, info.project.name, "01-4-artifact");

  await page.getByRole("button", { name: "Version history" }).click();
  await expect(page.getByRole("dialog", { name: "Version history" }).getByText("v1")).toBeVisible();
  await shot(page, info.project.name, "01-6-versions");
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\/camerabuddy\/roadmap\/plan$/);
  await page.getByRole("button", { name: "Pages" }).click();
  await expect(page.getByRole("dialog").getByText("Research")).toBeVisible();
  await shot(page, info.project.name, "01-5-switcher");
  await page.getByRole("dialog").getByRole("link", { name: /Mocks/ }).click();
  await expect(page).toHaveURL(/\/roadmap\/mocks$/);
  expect(errors).toEqual([]);
});

test("the canvas: every frame drawn, changed marked, fit, frames list and deep links", async ({
  page,
}, info) => {
  const errors = watchErrors(page);
  await page.goto("/camerabuddy/roadmap/mocks");
  await expect(page.locator(".fr")).toHaveCount(26);
  await expect(page.locator(".fr.chg")).toHaveCount(1);
  await expect(page.locator(".brd").first()).toContainText("Onboarding");
  await page.waitForTimeout(400);
  await shot(page, info.project.name, "02-1-overview");

  await page.getByRole("button", { name: "Frames" }).click();
  await page.getByRole("button", { name: /Changed 1/ }).click();
  await shot(page, info.project.name, "02-5-frames");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Live view/ })
    .click();
  await expect(page).toHaveURL(/#frame=live-view$/);
  await expect(page.locator(".capsule b")).toHaveText("Live view");
  await page.waitForTimeout(500);
  await shot(page, info.project.name, "02-2-one-frame");

  // The picture got sharper after decode, without ever going blank.
  await expect(page.locator('.fr[data-frame="live-view"] img')).not.toHaveAttribute(
    "src",
    (await page.locator('.fr[data-frame="welcome"] img').getAttribute("src")) as string,
  );

  await page.goto("/camerabuddy/roadmap/mocks#frame=timer");
  await expect(page.locator(".capsule b")).toHaveText("Timer");
  expect(errors).toEqual([]);
});

test("canvas gestures: pan and pinch with touch", async ({ page, browserName }, info) => {
  test.skip(info.project.name !== "iphone", "touch only");
  expect(browserName).toBe("webkit");
  await page.goto("/camerabuddy/roadmap/mocks");
  await expect(page.locator(".fr")).toHaveCount(26);
  const before = await transform(page);

  const fire = (type: string, id: number, x: number, y: number) =>
    page.locator(".cv").dispatchEvent(type, {
      pointerId: id,
      clientX: x,
      clientY: y,
      bubbles: true,
      pointerType: "touch",
      isPrimary: id === 1,
    });

  await fire("pointerdown", 1, 100, 300);
  await fire("pointermove", 1, 140, 340);
  await fire("pointermove", 1, 180, 380);
  await fire("pointerup", 1, 180, 380);
  const panned = await transform(page);
  expect(panned.x).toBeGreaterThan(before.x + 50);
  expect(panned.y).toBeGreaterThan(before.y + 50);
  expect(panned.s).toBe(before.s);

  await fire("pointerdown", 1, 150, 300);
  await fire("pointerdown", 2, 250, 300);
  await fire("pointermove", 1, 100, 300);
  await fire("pointermove", 2, 300, 300);
  await fire("pointerup", 1, 100, 300);
  await fire("pointerup", 2, 300, 300);
  expect((await transform(page)).s).toBeGreaterThan(panned.s * 1.5);
});

test("canvas: double-tap fits a frame and back; the keyboard works", async ({ page }, info) => {
  await page.goto("/camerabuddy/roadmap/mocks#frame=timer");
  await expect(page.locator(".capsule b")).toHaveText("Timer");
  await page.waitForTimeout(300);
  const box = page.viewportSize() as { width: number; height: number };
  const tap = async () => {
    const at = { x: box.width / 2, y: box.height / 2 };
    const fire = (type: string) =>
      page
        .locator(".cv")
        .dispatchEvent(type, { pointerId: 1, clientX: at.x, clientY: at.y, bubbles: true, isPrimary: true });
    await fire("pointerdown");
    await fire("pointerup");
  };
  await tap();
  await page.waitForTimeout(60);
  await tap();
  await expect(page.locator(".capsule b")).toHaveText("Mocks");
  if (info.project.name === "desktop") {
    await page.keyboard.press("n");
    await expect(page.locator(".capsule b")).toHaveText("Welcome");
    await page.keyboard.press("0");
    await page.keyboard.press("1");
    await expect.poll(async () => (await transform(page)).s).toBeCloseTo(1, 5);
  }
});

test("the article: blocks, embeds, changed sections, settings and contents", async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto("/camerabuddy/roadmap/plan");
  await expect(page.getByRole("heading", { name: "Camera Buddy roadmap" })).toBeVisible();
  await expect(page.locator('[data-block="phase-1"]')).toHaveText("Phase 1");
  await expect(page.locator('[data-block="phase-0/p2"]')).toBeVisible();
  await expect(page.locator('[data-verdict="verified"]')).toBeVisible();
  await expect(page.locator(".article svg").first()).toBeVisible();
  await expect(page.locator(".article figure img").first()).toHaveJSProperty("complete", true);
  await page
    .locator(".article figure img")
    .first()
    .evaluate((img: HTMLImageElement) => img.decode());
  expect(
    await page
      .locator(".article figure img")
      .first()
      .evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(page.getByText("1 section changed since the last version.")).toBeVisible();
  await shot(page, info.project.name, "03-1-reading");

  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".show-changes [data-changed]")).toHaveCount(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);

  await page.getByRole("button", { name: "Reading settings" }).click();
  await page.getByRole("button", { name: "Large" }).click();
  await page.getByRole("button", { name: "Sans" }).click();
  await expect(page.locator(".article")).toHaveAttribute("style", /--ui/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("artifacts.read.font"))).toBe("sans");
  await page.reload();
  await expect(page.locator(".article")).toHaveAttribute("style", /21px/);
  await expect(page.locator(".article")).toHaveAttribute("style", /--ui/);
  await shot(page, info.project.name, "03-6-settings");

  await page.getByRole("button", { name: "Contents" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Phase 2" }).click();
  await expect(page.locator('[data-block="phase-2"]')).toBeInViewport();
  expect(errors).toEqual([]);
});

test("a pinned version shows that version", async ({ page }) => {
  await page.goto("/camerabuddy/roadmap/v/1/plan");
  await expect(page.locator(".capsule .vchip")).toHaveText("v1");
  await expect(page.getByText("Ship pairing, live view")).toBeVisible();
  await page.goto("/camerabuddy/roadmap/plan?v=1");
  await expect(page.locator(".capsule .vchip")).toHaveText("v1");
  await page.goto("/camerabuddy/roadmap/v/9/plan");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
});

test("signed-out visitors are sent to sign in and back", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("http://localhost:18080/camerabuddy/roadmap/plan");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await context.close();
});
