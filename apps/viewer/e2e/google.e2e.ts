import { expect, type Page, test } from "@playwright/test";

const shot = async (page: Page, project: string, name: string) => {
  if (project === "iphone") await page.screenshot({ path: `../../docs/mocks/shots/${name}.png` });
};
const client = "1234.apps.googleusercontent.com";

// Playwright can't see requests from a page a service worker controls, so a mock there silently isn't one.
test.use({ serviceWorkers: "block" });

/** The server has no Google in e2e, so these answers stand in for one that's set up. */
const pretendGoogleIsOn = (page: Page) =>
  page.route("**/api/meta", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), google: true } });
  });

test("with Google off, the sign-in page doesn't mention it", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  await context.close();
});

test("with Google on, sign-in offers a link, and says why it didn't work", async ({ browser }, info) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    ...(info.project.name === "iphone"
      ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
      : {}),
  });
  const page = await context.newPage();
  await pretendGoogleIsOn(page);
  await page.goto("/sign-in?google=link-first&next=%2Fsettings%2Fsign-in");
  await expect(page.getByText("Sign in once the usual way to connect Google.")).toBeVisible();
  const link = page.getByRole("link", { name: "Continue with Google" });
  await expect(link).toHaveAttribute("href", /^\/api\/auth\/google\/start\?intent=signin/);
  await shot(page, info.project.name, "10-1-sign-in");
  await context.close();
});

test("Settings shows an admin what to paste and what's left to do", async ({ page }, info) => {
  await page.route("**/api/org/google", (route) =>
    route.fulfill({
      json: {
        clientId: client,
        hasSecret: true,
        enabled: false,
        tested: false,
        redirectUris: ["https://art.example.org/api/auth/google/callback"],
        autoJoin: null,
      },
    }),
  );
  await page.goto("/settings/google");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Google sign-in");
  await expect(page.getByText("https://art.example.org/api/auth/google/callback")).toBeVisible();
  await expect(page.getByLabel("Client secret")).toHaveAttribute(
    "placeholder",
    "Saved, and never shown again",
  );
  await expect(page.getByRole("button", { name: "On", exact: true })).toBeDisabled();
  await shot(page, info.project.name, "10-2-settings");
});

test("the re-auth sheet offers what the person has, with a passkey first", async ({ page }) => {
  await page.route("**/api/me/identities", (route) =>
    route.fulfill({
      json: {
        identities: [{ id: "x", provider: "google", email: "a@example.com", lastUsedAt: null }],
        passkeys: 0,
        password: false,
        google: true,
      },
    }),
  );
  await page.route("**/api/me/password", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "recent_auth_required", message: "Sign in again.", details: {} } },
    }),
  );
  await page.goto("/settings/sign-in");
  await page
    .getByRole("button", { name: /password/i })
    .first()
    .click();
  await page.getByLabel("New password").fill("a perfectly long password");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Confirm it's you")).toBeVisible();
  const link = page.locator(".sheet").getByRole("link", { name: "Continue with Google" });
  await expect(link).toHaveAttribute("href", /intent=reauth/);
  await expect(page.getByRole("button", { name: "Use a passkey" })).toHaveCount(0);
  await expect(page.locator("#reauth-password")).toHaveCount(0);
});
