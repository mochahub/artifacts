import { type Browser, expect, type Page, test } from "@playwright/test";
import { OWNER } from "./helpers.ts";

const shot = async (page: Page, project: string, name: string) => {
  if (project === "iphone") await page.screenshot({ path: `../../docs/mocks/shots/${name}.png` });
};
const stranger = (browser: Browser, project: string) =>
  browser.newContext({
    storageState: { cookies: [], origins: [] },
    ...(project === "iphone"
      ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true }
      : {}),
  });

test("invite someone, they join, and see organization work", async ({ page, browser }, info) => {
  const email = `sam-${info.project.name}@example.com`;
  await page.goto("/settings/people");
  await expect(page.getByText(OWNER.email)).toBeVisible();
  await shot(page, info.project.name, "06-4-people");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Copy invite link" }).click();
  await shot(page, info.project.name, "06-5-invite");
  const url = await page.locator(".sheet .mono").textContent();
  expect(url).toContain("/join/");

  const context = await stranger(browser, info.project.name);
  const guest = await context.newPage();
  await guest.goto(url as string);
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Join Mochahub");
  await shot(guest, info.project.name, "06-6-accept");
  await guest.getByLabel("Your name").fill("Sam");
  await guest.getByRole("button", { name: "Use a password instead" }).click();
  await guest.getByLabel("Password").fill("a perfectly long password");
  await guest.getByRole("button", { name: "Join" }).click();
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Review");
  await guest.goto("/camerabuddy/roadmap");
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Camera Buddy roadmap");
  await context.close();
});

test("a guest arrives by link, names themselves and comments; revoking stops them", async ({
  page,
  browser,
}, info) => {
  await page.goto("/camerabuddy/roadmap");
  await page.getByRole("button", { name: "Share" }).click();
  await shot(page, info.project.name, "05-1-share");
  await page.getByRole("button", { name: "Copy link" }).click();
  const url = await page.getByTestId("share-url").textContent();

  const context = await stranger(browser, info.project.name);
  const guest = await context.newPage();
  await guest.goto(url as string);
  await expect(guest.getByText("Zahin shared this with you")).toBeVisible();
  await guest.waitForTimeout(200);
  await shot(guest, info.project.name, "05-2-guest");
  await guest.getByLabel("Your name").fill("Riley");
  await guest.getByRole("button", { name: "Start reviewing" }).click();
  await expect(guest).toHaveURL(/\/camerabuddy\/roadmap$/);
  await guest.getByRole("link", { name: /Start reviewing|Review changes/ }).click();
  await guest.locator(".vbar").getByRole("button", { name: "Comment", exact: true }).click();
  await guest.locator("[data-block]").first().click();
  const sheet = guest.getByRole("dialog", { name: "New comment" });
  await sheet.getByLabel("Comment").fill(`From a guest ${info.project.name}`);
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(guest.locator(".mm").first()).toBeVisible();
  if (info.project.name === "iphone") await guest.getByRole("button", { name: "Comments" }).click();
  await expect(guest.getByText(`From a guest ${info.project.name}`).last()).toBeVisible();
  await expect(guest.getByRole("button", { name: "Copy prompt for your agent" })).toHaveCount(0);

  const revoke = page.getByRole("button", { name: "Revoke this link" });
  while ((await revoke.count()) > 0) {
    const before = await revoke.count();
    await revoke.first().click();
    await expect(revoke).toHaveCount(before - 1);
  }
  await guest.reload();
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
  await context.close();
});

test("settings: sign-in, domains, organization and tokens render for an owner", async ({ page }, info) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /People/ })).toBeVisible();
  await page.goto("/settings/sign-in");
  await expect(page.getByRole("button", { name: "Add a passkey" })).toBeVisible();
  await shot(page, info.project.name, "06-3-sign-in-settings");
  await page.goto("/settings/domains");
  await expect(page.getByText("Home of your passkeys. Keep it attached")).toBeVisible();
  await shot(page, info.project.name, "06-9-domains");
  await page.goto("/settings/org");
  await expect(page.getByLabel("Name")).toHaveValue("Mochahub");
  await page.goto("/settings/tokens");
  await page.getByLabel("Name").fill(`CI ${info.project.name}`);
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("Copy it now. It's only shown once.")).toBeVisible();
});
