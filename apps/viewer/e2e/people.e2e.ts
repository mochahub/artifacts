import { expect, test } from "@playwright/test";
import { invite, OWNER, shot, stranger, token } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test("invite someone, they join, and see organization work", async ({ page, browser }, info) => {
  const email = `sam-${info.project.name}@example.com`;
  await page.goto("/settings/people");
  await expect(page.getByText(OWNER.email)).toBeVisible();
  await shot(page, "06-4-people");
  const url = await invite(page, email, "Reviewer");
  await shot(page, "06-5-invite");

  const context = await stranger(browser);
  const guest = await context.newPage();
  await guest.goto(url);
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Join Mochahub");
  await shot(guest, "06-6-accept");
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
  test.setTimeout(120_000);
  // Its own copy, so revoking its link can't stop the other run's guest.
  const slug = `shared-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  await shot(page, "05-1-share");
  await page.getByRole("button", { name: "Copy link" }).click();
  const url = await page.getByTestId("share-url").textContent();

  const context = await stranger(browser);
  const guest = await context.newPage();
  await guest.goto(url as string);
  await expect(guest.getByText("Zahin shared this with you")).toBeVisible();
  await guest.waitForTimeout(200);
  await shot(guest, "05-2-guest");
  await guest.getByLabel("Your name").fill("Riley");
  await guest.getByRole("button", { name: "Start reviewing" }).click();
  await expect(guest).toHaveURL(new RegExp(`/camerabuddy/${slug}$`));
  await guest.getByRole("link", { name: /Start reviewing|Review changes/ }).click();
  await guest.locator(".vbar").getByRole("button", { name: "Comment", exact: true }).click();
  await guest.locator("[data-block]").first().click();
  const sheet = guest.getByRole("dialog", { name: "New comment" });
  await sheet.getByLabel("Comment").fill(`From a guest ${info.project.name}`);
  await sheet.getByRole("button", { name: "Post" }).click();
  await expect(guest.getByRole("button", { name: /^Comment \d+$/ })).toBeVisible();
  if (info.project.name === "iphone") await guest.getByRole("button", { name: "Comments" }).click();
  await expect(guest.getByText(`From a guest ${info.project.name}`).last()).toBeVisible();
  await expect(guest.getByRole("button", { name: "Copy prompt for your agent" })).toHaveCount(0);

  const revoke = page.getByRole("button", { name: "Revoke this link" });
  await revoke.click();
  await expect(revoke).toHaveCount(0);
  await guest.reload();
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
  await context.close();
});

test("settings: sign-in, domains, organization and tokens render for an owner", async ({ page }, info) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /People/ })).toBeVisible();
  await page.goto("/settings/sign-in");
  await expect(page.getByRole("button", { name: "Add a passkey" })).toBeVisible();
  await shot(page, "06-3-sign-in-settings");
  await page.goto("/settings/domains");
  await expect(page.getByText("Home of your passkeys. Keep it attached")).toBeVisible();
  await shot(page, "06-9-domains");
  await page.goto("/settings/org");
  await expect(page.getByLabel("Name")).toHaveValue("Mochahub");
  await page.goto("/settings/tokens");
  await page.getByLabel("Name").fill(`CI ${info.project.name}`);
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("Copy it now. It's only shown once.")).toBeVisible();
});
