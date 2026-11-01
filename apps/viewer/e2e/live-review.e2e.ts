import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { publishCopy, publishFixture } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });
const token = () => readFileSync("e2e/.token", "utf8").trim();
const auth = () => ({ Authorization: `Bearer ${token()}` });

test("a comment from elsewhere appears without a reload", async ({ page, request }, info) => {
  const slug = `rt-${info.project.name}`;
  publishCopy(slug, token());
  const stream = page.waitForResponse((response) => response.url().includes("/api/events"));
  await page.goto(`/camerabuddy/${slug}/plan`);
  await stream;
  const artifact = await (
    await request.get(`/api/artifacts/by-slug/camerabuddy/${slug}`, { headers: auth() })
  ).json();
  await page.waitForTimeout(400);
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/threads"), {
    timeout: 4000,
  });
  const posted = await request.post(`/api/artifacts/${artifact.id}/threads`, {
    headers: auth(),
    data: { pageKey: "plan", version: 1, anchor: null, body: "Seen from another device", agent: "Claude" },
  });
  expect(posted.ok()).toBe(true);
  // Faster than the 10-second poll, which is off while a stream is open.
  await refreshed;
});

test("search finds an artifact from the Search tab", async ({ page }, info) => {
  const slug = `find-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto("/search");
  await page.getByLabel("Search").fill(`Roadmap ${slug}`);
  await page
    .locator(".li")
    .filter({ hasText: `Roadmap ${slug}` })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/camerabuddy/${slug}`));
});

test("search finds words inside an article, and opens that page", async ({ page }, info) => {
  const slug = `words-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto("/search");
  await page.getByLabel("Search").fill("plain and short");
  const hit = page
    .locator(".li")
    .filter({ hasText: `Roadmap ${slug}` })
    .first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/camerabuddy/${slug}/research-`));
});

test("⌘K opens search anywhere", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboards only");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
});

test("a gallery opens into a lightbox and steps through", async ({ page }, info) => {
  const slug = `gal-${info.project.name}`;
  publishFixture("gallery", slug, token());
  await page.goto(`/demo/${slug}/photos`);
  await page.getByRole("button", { name: "Second take" }).click();
  const light = page.getByRole("dialog", { name: "Second take" });
  await expect(light).toBeVisible();
  await light.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "First light" })).toBeVisible();
  await page.screenshot({
    path: `../../docs/mocks/shots/${info.project.name === "iphone" ? "" : "desktop-"}gallery.png`,
  });
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".light")).toHaveCount(0);
});

test("compare: side by side, swipe, and changes with numbered regions", async ({ page }, info) => {
  const slug = `cmp-${info.project.name}`;
  publishCopy(slug, token(), true);
  await page.goto(`/camerabuddy/${slug}/compare?from=1&to=2`);
  await expect(page.getByRole("button", { name: "Side by side" })).toBeVisible();
  await expect(page.locator(".diff .pair img").first()).toBeVisible();
  await page.getByRole("button", { name: "Swipe" }).click();
  await expect(page.locator(".diff .swipe input").first()).toBeVisible();
  await page.getByRole("button", { name: "Changes" }).click();
  await expect(page.locator(".diff .region").first()).toBeVisible();
  await page.screenshot({
    path: `../../docs/mocks/shots/${info.project.name === "iphone" ? "" : "desktop-"}compare-changes.png`,
  });
});

test("after a first comment on iPhone, the install sheet shows once", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "the iPhone path");
  const slug = "install-prompt";
  publishCopy(slug, token());
  // Safari's real user agent: the test browser's doesn't say iPhone, and the sheet only shows there.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone) Safari" });
  });
  await page.goto(`/camerabuddy/${slug}/plan`);
  await page.evaluate(() => localStorage.removeItem("artifacts.install-asked"));
  await expect(page.locator("[data-block]").nth(2)).toBeVisible();
  const comment = async (text: string) => {
    await page.locator(".vbar").getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator("[data-block]").nth(2).click();
    const sheet = page.getByRole("dialog", { name: "New comment" });
    await sheet.getByLabel("Comment").fill(text);
    await sheet.getByRole("button", { name: "Post" }).click();
    await expect(sheet).toHaveCount(0);
  };
  await comment("First one");
  const prompt = page.getByRole("dialog", { name: "Get notified when an agent replies" });
  await expect(prompt.getByText("Add to Home Screen")).toBeVisible();
  await page.screenshot({ path: "../../docs/mocks/shots/05-6-install.png" });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await comment("Second one");
  await page.waitForTimeout(300);
  await expect(prompt).toHaveCount(0);
});
