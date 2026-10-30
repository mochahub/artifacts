import { expect, type Page, test } from "@playwright/test";

/** Fails on anything the browser refused, such as a CSP violation from the server's headers. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("home talks to the server, under the real CSP", async ({ page }) => {
  const errors = watchErrors(page);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Artifacts");
  await expect(page.getByText("This deployment isn't set up yet.")).toBeVisible();
  await expect(page.getByText(/^Server version \d/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("a deep link loads the app, and the router shows Nothing here", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/no/such/route");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
  await page.getByRole("link", { name: "Go to Artifacts" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Artifacts");
  expect(errors).toEqual([]);
});

test("tokens are applied, and text is big enough that Safari won't zoom", async ({ page }) => {
  await page.goto("/");
  const style = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return {
      size: body.fontSize,
      mark: getComputedStyle(document.documentElement).getPropertyValue("--mark").trim(),
    };
  });
  expect(style).toEqual({ size: "16px", mark: "#ffd84d" });
});
