import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { OWNER, SETUP_TOKEN, signIn } from "./helpers.ts";

// A board-only run does not publish or screenshot the unrelated legacy acceptance fixture.
test("claim the private board stack", async ({ page, request }) => {
  const response = await request.post("/api/setup", {
    data: { setupToken: SETUP_TOKEN, orgName: "Board acceptance", clientName: "boards", ...OWNER },
  });
  expect(response.ok(), await response.text()).toBe(true);
  writeFileSync(process.env.E2E_TOKEN_FILE ?? "e2e/.token", (await response.json()).token);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await page.evaluate(() => localStorage.setItem("artifacts.install-asked", "1"));
  await page.context().storageState({ path: process.env.E2E_AUTH_FILE ?? "e2e/.auth.json" });
});
