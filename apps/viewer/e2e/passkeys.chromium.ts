import type { ApiErrorBody } from "@artifacts/schema";
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { OWNER } from "./helpers.ts";

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

/** An invite link from the owner, over the API: nobody is signed in in this project's browsers. */
async function inviteLink(request: APIRequestContext, origin: string) {
  const signedIn = await request.post("/api/auth/password", {
    data: { email: OWNER.email, password: OWNER.password },
  });
  expect(signedIn.status()).toBe(200);
  const made = await request.post("/api/invites", {
    headers: { Origin: origin },
    // Both tests run at once, so the time alone could name the same person twice.
    data: { email: `pk-${crypto.randomUUID()}@example.com`, role: "reviewer" },
  });
  expect(made.status()).toBe(200);
  return ((await made.json()) as { url: string }).url;
}

test("add a passkey, sign in with it alone, and re-authenticate with it", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  await authenticator(context, page);
  // Someone of their own: a passkey left on the owner every other test signs in as would outlive this one.
  await page.goto(await inviteLink(request, baseURL as string));
  await page.getByLabel("Your name").fill("Pat");
  await page.getByRole("button", { name: "Use a password instead" }).click();
  await page.getByLabel("Password").fill("a perfectly long password");
  await page.getByRole("button", { name: "Join" }).click();
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

  // A sign-in this fresh is recent enough for anything, so the first answer stands in for an older one.
  await page.route(
    "**/api/me/password",
    (route) =>
      route.fulfill({
        status: 401,
        json: {
          error: { code: "recent_auth_required", message: "Sign in again.", details: {} },
        } satisfies ApiErrorBody,
      }),
    { times: 1 },
  );
  await page.goto("/settings/sign-in");
  await page.getByRole("button", { name: /^Change password/ }).click();
  await page.getByLabel("New password").fill("another perfectly long password");
  await page.getByRole("button", { name: "Save password" }).click();
  const sheet = page.getByRole("dialog", { name: "Confirm it's you" });
  const confirmed = page.waitForResponse((response) => response.url().endsWith("/api/auth/reauth"));
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/me/password") && response.status() !== 401,
  );
  await sheet.getByRole("button", { name: "Use a passkey" }).click();
  expect((await confirmed).status()).toBe(200);
  // Confirmed, the change goes through by itself.
  expect((await saved).status()).toBe(200);
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Change password" })).toHaveCount(0);
});

test("join by invite with a passkey as the only credential", async ({ page, context, request, baseURL }) => {
  await authenticator(context, page);
  await page.goto(await inviteLink(request, baseURL as string));
  await page.getByLabel("Your name").fill("Sam");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await page.goto("/settings/sign-in");
  await expect(page.getByRole("button", { name: /^Remove / })).toBeVisible();
  await page.getByRole("button", { name: /^Remove / }).click();
  await expect(page.getByText("This is your only way to sign in.")).toBeVisible();
});
