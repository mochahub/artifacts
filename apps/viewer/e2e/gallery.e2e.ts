import { expect, test } from "@playwright/test";
import { shot, token } from "./helpers.ts";
import { publishFixture } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

test("a gallery opens into a lightbox and steps through", async ({ page }, info) => {
  const slug = `gal-${info.project.name}`;
  publishFixture("gallery", slug, token());
  await page.goto(`/demo/${slug}/photos`);
  await page.getByRole("button", { name: "Second take" }).click();
  const light = page.getByRole("dialog", { name: "Second take" });
  await expect(light).toBeVisible();
  await light.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "First light" })).toBeVisible();
  await shot(page, "gallery", { desktop: true });
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".light")).toHaveCount(0);
});
