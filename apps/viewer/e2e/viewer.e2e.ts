import { expect, type Page, test } from "@playwright/test";
import {
  box,
  here,
  overflowsSideways,
  pointer,
  settle,
  shot,
  tap,
  transform,
  watchErrors,
} from "./helpers.ts";

const desktop = { desktop: true };
/** The fixture's artifact as a tile in a project. */
const roadmapTile = (page: Page) => page.getByRole("link", { name: /Camera Buddy roadmap/ });

test("projects and a project list the fixture", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.getByText("Camera Buddy roadmap").first()).toBeVisible();

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: /Camera Buddy/ }).last()).toBeVisible();
  await shot(page, "01-2-projects", desktop);

  await page.goto("/camerabuddy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Camera Buddy");
  await expect(roadmapTile(page)).toBeVisible();
  // Every filter and the sort control fit on a phone, with nothing past the edge.
  expect(await overflowsSideways(page)).toBe(false);
  const width = (page.viewportSize() as { width: number }).width;
  for (const name of ["All", "Your turn", "Approved", "Archived"]) {
    const button = page.locator(".seg button", { hasText: name });
    const b = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right, clipped: el.scrollWidth > el.clientWidth };
    });
    expect(b.right).toBeLessThanOrEqual(width);
    expect(b.clipped).toBe(false);
  }
  expect((await box(page, ".sort")).right).toBeLessThanOrEqual(width);

  // Retyping never empties the grid: the last list stays until the next answer lands. The one
  // delayed handler removes itself; unrouting a sleeping handler makes its continue() throw.
  await page.route(
    "**/artifacts?*",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    },
    { times: 1 },
  );
  const asked = page.waitForRequest("**/artifacts?*");
  await page.getByLabel("Find in this project").fill("ro");
  await asked;
  await expect(roadmapTile(page)).toBeVisible();
  await expect(page.getByText("Nothing here.")).toHaveCount(0);

  await page.getByRole("button", { name: "Approved" }).click();
  await expect(page.getByText("Nothing here.")).toBeVisible();
  await page.getByRole("button", { name: "All" }).click();
  await page.getByLabel("Find in this project").fill("nope");
  await expect(page.getByText("Nothing here.")).toBeVisible();
  await page.getByLabel("Find in this project").fill("road");
  await expect(roadmapTile(page)).toBeVisible();
  await shot(page, "01-3-project", desktop);
  expect(errors).toEqual([]);
});

test("the artifact shows what changed, with the page switcher and version history", {
  tag: "@smoke",
}, async ({ page }) => {
  const errors = watchErrors(page);
  // A cold load shows the page's shape, never a blank screen, until the artifact arrives.
  await page.route(
    "**/api/artifacts/by-slug/**",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    },
    { times: 1 },
  );
  await page.goto("/camerabuddy/roadmap");
  await expect(page.locator(".ph-line").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Camera Buddy roadmap");
  await expect(page.getByText("What changed in v2")).toBeVisible();
  await expect(page.getByText("9 pages")).toBeVisible();
  // The detail page lives in the shell: tabs on a phone, the rail on a desktop, and the project by name.
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Camera Buddy", exact: true }).first(),
  ).toHaveAttribute("href", "/camerabuddy");
  await expect(page.getByRole("button", { name: "More" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Approve or request changes" })).toHaveText(
    "Approve or request changes",
  );
  await expect(page).toHaveTitle("Camera Buddy roadmap – Mochahub");
  await shot(page, "01-4-artifact", desktop);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Version history" }).click();
  await expect(page.getByRole("dialog", { name: "Version history" }).getByText("v1")).toBeVisible();
  await shot(page, "01-6-versions", desktop);
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Review changes" }).click();
  await expect(page).toHaveURL(/\/camerabuddy\/roadmap\/plan$/);
  await page.getByRole("button", { name: "Pages" }).click();
  await expect(page.getByRole("dialog").getByText("Research")).toBeVisible();
  await shot(page, "01-5-switcher", desktop);
  await page.getByRole("dialog").getByRole("link", { name: /Mocks/ }).click();
  await expect(page).toHaveURL(/\/roadmap\/mocks$/);
  await expect(page.getByRole("img")).toHaveCount(26);
  await expect
    .poll(() =>
      page
        .getByRole("img")
        .evaluateAll((images) =>
          images.every(
            (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("the canvas: every frame drawn, changed marked, fit, frames list and deep links", async ({
  page,
}, info) => {
  const errors = watchErrors(page);
  await page.goto("/camerabuddy/roadmap/mocks");
  await expect(page.getByRole("img")).toHaveCount(26);
  // Marked on the canvas, where only its outline says so.
  await expect(page.locator(".fr.chg")).toHaveCount(1);
  await expect(page.getByText("Onboarding").first()).toBeVisible();
  await settle(page);
  await shot(page, "02-1-overview", desktop);

  await page.getByRole("button", { name: "Frames" }).click();
  await page.getByRole("button", { name: /Changed 1/ }).click();
  await shot(page, "02-5-frames", desktop);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Live view/ })
    .click();
  await expect(page).toHaveURL(/#frame=live-view$/);
  await expect(here(page, "Live view")).toBeVisible();
  await settle(page);
  await shot(page, "02-2-one-frame", desktop);
  if (info.project.name === "desktop") {
    // The comments panel has its column: the canvas, the capsule and the toolbar keep to the rest.
    const panel = await box(page, ".panel");
    const canvas = await box(page, ".cv");
    expect(canvas.right).toBeLessThanOrEqual(panel.x + 1);
    for (const selector of [".capsule", ".vbar"]) {
      const b = await box(page, selector);
      expect(b.x + b.w / 2).toBeCloseTo(panel.x / 2, -1);
    }
    // The focused frame and its board's title are both in view, under neither the capsule nor the panel.
    const frame = await box(page, '.fr[data-frame="live-view"]');
    const title = await box(page, ".brd:nth-child(2)");
    expect(frame.right).toBeLessThanOrEqual(panel.x);
    expect(title.y).toBeGreaterThanOrEqual((await box(page, ".capsule")).bottom);
  }

  // The picture got sharper after decode, without ever going blank.
  await expect(page.locator('.fr[data-frame="live-view"] img')).not.toHaveAttribute(
    "src",
    (await page.locator('.fr[data-frame="welcome"] img').getAttribute("src")) as string,
  );

  await page.goto("/camerabuddy/roadmap/mocks#frame=timer");
  await expect(here(page, "Timer")).toBeVisible();
  expect(errors).toEqual([]);
});

test("canvas gestures: pan and pinch with touch", async ({ page, browserName }, info) => {
  test.skip(info.project.name !== "iphone", "touch only");
  expect(browserName).toBe("webkit");
  await page.goto("/camerabuddy/roadmap/mocks");
  await expect(page.getByRole("img")).toHaveCount(26);
  await settle(page);
  const before = await transform(page);
  const fire = (type: string, id: number, x: number, y: number) =>
    pointer(page, type, x, y, { id, touch: true });

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
  await expect(here(page, "Timer")).toBeVisible();
  await settle(page);
  const screen = page.viewportSize() as { width: number; height: number };
  await tap(page, screen.width / 2, screen.height / 2);
  // Two taps a moment apart, as a finger makes them.
  await page.waitForTimeout(60);
  await tap(page, screen.width / 2, screen.height / 2);
  await expect(here(page, "Mocks")).toBeVisible();
  if (info.project.name === "desktop") {
    await page.keyboard.press("n");
    await expect(here(page, "Welcome")).toBeVisible();
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
  // Visible: a picture v2 replaced is kept, hidden, until Changes is on.
  const figure = page.locator(".article figure img").filter({ visible: true }).first();
  await expect(figure).toHaveJSProperty("complete", true);
  await figure.evaluate((img: HTMLImageElement) => img.decode());
  expect(await figure.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // The fixture's v2 rewords a sentence and swaps a board picture, which an embedded frame may show.
  await expect(page.getByText(/^Changed in \d+ places? since v1\.$/)).toBeVisible();
  await expect(page).toHaveTitle("Plan – Camera Buddy roadmap – Mochahub");
  await shot(page, "03-1-reading", desktop);
  if (info.project.name === "desktop") {
    const panel = await box(page, ".panel");
    expect((await box(page, ".article")).right).toBeLessThanOrEqual(panel.x);
    const capsule = await box(page, ".capsule");
    expect(capsule.x + capsule.w / 2).toBeCloseTo(panel.x / 2, -1);
  }

  // The words v2 added, marked where they are; hidden until Changes is on.
  await expect(page.locator(".article ins.chg")).toHaveText("a faster");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".show-changes ins.chg", { hasText: "a faster" })).toBeInViewport();

  expect(await overflowsSideways(page)).toBe(false);

  await page.getByRole("button", { name: "Reading settings" }).click();
  await page.getByRole("button", { name: "Large" }).click();
  await page.getByRole("button", { name: "Sans" }).click();
  await expect(page.locator(".article")).toHaveAttribute("style", /--ui/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("artifacts.read.font"))).toBe("sans");

  // Dark is the reader's choice whatever the system is (these browsers run light), and only on this page.
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await background();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(background).not.toBe(light);
  await page.getByRole("button", { name: "Light" }).click();
  await expect.poll(background).toBe(light);
  await page.getByRole("button", { name: "Dark" }).click();
  await page.getByRole("button", { name: "Auto" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  await page.reload();
  await expect(page.locator(".article")).toHaveAttribute("style", /21px/);
  await expect(page.locator(".article")).toHaveAttribute("style", /--ui/);
  await shot(page, "03-6-settings", desktop);

  // Images above the target change the layout as they load, so settle first.
  await page
    .locator(".article figure img")
    .first()
    .evaluate((img: HTMLImageElement) => img.decode());
  await page.getByRole("button", { name: "Contents" }).click();
  // Focus moves into the sheet, so a keyboard or screen reader user isn't left behind the dim.
  await expect(page.getByRole("dialog", { name: "Contents" })).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Phase 2" }).click();
  await expect(page.locator('[data-block="phase-2"]')).toBeInViewport();
  expect(errors).toEqual([]);
});

test("the reader's glass draws back on the way down and fits its ink to a picture", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "iphone", "phone only");
  const errors = watchErrors(page);
  await page.goto("/camerabuddy/roadmap/plan");
  const root = page.locator("html");
  const bar = page.locator(".vbar");
  const picture = page.locator(".article img").filter({ visible: true }).first();
  await expect(picture).toBeAttached();
  await expect(root).not.toHaveClass(/reading/);
  await expect(bar.getByText("Contents")).toBeVisible();
  const full = (await bar.boundingBox())?.height as number;

  await picture.evaluate((image) => {
    const box = image.getBoundingClientRect();
    const barTop = (document.querySelector(".vbar") as HTMLElement).getBoundingClientRect().top;
    scrollTo(0, scrollY + box.top + box.height / 2 - barTop - 26);
  });
  await expect(root).toHaveClass(/reading/);
  // The bar draws back: shorter than it stands at rest.
  await expect.poll(async () => (await bar.boundingBox())?.height).toBeLessThan(full);
  await expect(bar).toHaveAttribute("data-tone", /dark|light/);
  if (process.env.GLASS_SHOT) await page.screenshot({ animations: "disabled", path: process.env.GLASS_SHOT });

  await page.evaluate(() => scrollBy(0, -40));
  await expect(root).not.toHaveClass(/reading/);
  await expect.poll(async () => (await bar.boundingBox())?.height).toBe(full);
  expect(errors).toEqual([]);
});

test("a pinned version shows that version", async ({ page }) => {
  await page.goto("/camerabuddy/roadmap/v/1/plan");
  await expect(page.getByRole("button", { name: "Version history" })).toHaveText("v1");
  await expect(page.getByText("Ship pairing, live view")).toBeVisible();
  await page.goto("/camerabuddy/roadmap/plan?v=1");
  await expect(page.getByRole("button", { name: "Version history" })).toHaveText("v1");
  await page.goto("/camerabuddy/roadmap/v/9/plan");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
});

test("signed-out visitors are sent to sign in and back", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/camerabuddy/roadmap/plan");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await context.close();
});
