import { expect, test } from "@playwright/test";
import { token } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

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
