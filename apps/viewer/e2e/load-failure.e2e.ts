import { expect, test } from "@playwright/test";

// Requests the worker makes aren't routed, so it stays out of the way here.
test.use({ serviceWorkers: "block" });

test("an article that doesn't load says so, and Try again loads it", async ({ page }) => {
  let failing = true;
  await page.route("**/v/*/article/*", (route) =>
    failing ? route.fulfill({ status: 503, body: "" }) : route.continue(),
  );
  await page.goto("/camerabuddy/roadmap/plan");
  await expect(page.getByText("Couldn't load this.")).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator('[data-block="phase-1"]')).toHaveText("Phase 1");
  await expect(page.getByText("Couldn't load this.")).toHaveCount(0);
});
