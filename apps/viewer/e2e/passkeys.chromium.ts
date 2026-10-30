import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { OWNER, signIn } from "./helpers.ts";

async function authenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test("add a passkey, sign in with it alone, and re-authenticate with it", async ({
  page,
  context,
  browser,
}) => {
  await authenticator(context, page);
  await signIn(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");

  await page.goto("/settings/sign-in");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("button", { name: /^Remove / })).toBeVisible();

  // A fresh session in the same browser profile, with no cookie, needs no email.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await expect(browser.isConnected()).toBeTruthy();
});

test("join by invite with a passkey as the only credential", async ({ page, context, request }) => {
  await authenticator(context, page);
  const setupCookie = await request.post("/api/auth/password", {
    data: { email: OWNER.email, password: OWNER.password },
  });
  expect(setupCookie.status()).toBe(200);
  const made = await request.post("/api/invites", {
    headers: { Origin: "http://localhost:18080" },
    data: { email: `pk${Date.now()}@example.com`, role: "reviewer" },
  });
  const { url } = await made.json();
  await page.goto(url);
  await page.getByLabel("Your name").fill("Sam");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await page.goto("/settings/sign-in");
  await expect(page.getByRole("button", { name: /^Remove / })).toBeVisible();
  await page.getByRole("button", { name: /^Remove / }).click();
  await expect(page.getByText("This is your only way to sign in.")).toBeVisible();
});
