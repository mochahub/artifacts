import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { OWNER, SETUP_TOKEN, signIn, watchErrors } from "./helpers.ts";
import { seedFixture } from "./seed.ts";

test.describe.configure({ mode: "serial" });

test("setup mode: every route shows Almost ready, under the real CSP", async ({ page }) => {
  const errors = watchErrors(page);
  for (const path of ["/", "/some/deep/link", "/sign-in"]) {
    const response = await page.goto(path);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Almost ready");
  }
  await expect(page.getByText("artifacts setup http://localhost:18080")).toBeVisible();
  await page.screenshot({ path: "../../docs/mocks/shots/06-1-almost-ready.png" });
  expect(errors).toEqual([]);
});

test("claim the server and publish the fixture for the rest of the run", async ({ request }) => {
  test.setTimeout(180_000);
  const response = await request.post("/api/setup", {
    data: { setupToken: SETUP_TOKEN, orgName: "Mochahub", clientName: "e2e", ...OWNER },
  });
  expect(response.status()).toBe(200);
  const { token } = await response.json();
  writeFileSync("e2e/.token", token);
  seedFixture(token);
});

test("home: a new version is waiting, before anyone has looked at it", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await expect(page.getByText("Waiting on you")).toBeVisible();
  await expect(page.getByText("1 frame changed")).toBeVisible();
  await expect(page.getByText("Claude published v2")).toBeVisible();
  await expect(page.locator(".tab .count")).toHaveText("1");
  await page.locator(".cover img").evaluate((img: HTMLImageElement) => img.decode());
  await page.screenshot({ path: "../../docs/mocks/shots/01-1-review.png" });
  // Every other test reuses this session: signing in each time would hit the real per-IP limit.
  // The install sheet would otherwise cover every test's first comment; live-review.e2e.ts clears this.
  await page.evaluate(() => localStorage.setItem("artifacts.install-asked", "1"));
  await page.context().storageState({ path: "e2e/.auth.json" });
});
