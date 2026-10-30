import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test("a version you've opened works with no network", async ({ page, context }) => {
  publishCopy("offline", readFileSync("e2e/.token", "utf8").trim());
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await page.goto("/camerabuddy/offline/mocks");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The first load came before the worker took over, so this one fills its cache.
  await page.reload();
  const picture = page.locator("img").first();
  await expect(picture).toBeVisible();
  await page.waitForLoadState("networkidle");

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("img").first()).toBeVisible();
  expect(
    await page
      .locator("img")
      .first()
      .evaluate((image: HTMLImageElement) => image.complete),
  ).toBe(true);

  // Signing out must not leave that behind for the next person on this device.
  await context.setOffline(false);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/sign-in/);
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).filter((name) => name !== "shell-v1")))
    .toEqual([]);
});
