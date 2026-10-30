import { expect, test } from "@playwright/test";
import { OWNER, SETUP_TOKEN, watchErrors } from "./helpers.ts";

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

test("claim the server for the rest of the run", async ({ request }) => {
  const response = await request.post("/api/setup", {
    data: { setupToken: SETUP_TOKEN, orgName: "Mochahub", clientName: "e2e", ...OWNER },
  });
  expect(response.status()).toBe(200);
});
