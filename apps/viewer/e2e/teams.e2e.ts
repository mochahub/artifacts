import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { publishCopy } from "./seed.ts";

const shot = async (page: Page, project: string, name: string) => {
  if (project === "iphone") await page.screenshot({ path: `../../docs/mocks/shots/${name}.png` });
};
const stranger = (browser: Browser, project: string) =>
  browser.newContext({
    storageState: { cookies: [], origins: [] },
    ...(project === "iphone"
      ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
      : {}),
  });
const token = () => readFileSync("e2e/.token", "utf8");
test.describe.configure({ timeout: 120_000 });

/** Invites someone and signs them in, in a browser of their own. */
async function join(page: Page, browser: Browser, project: string, email: string, name: string) {
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Copy invite link" }).click();
  const url = await page.locator(".sheet .mono").textContent();
  const context = await stranger(browser, project);
  const other = await context.newPage();
  await other.goto(url as string);
  await other.getByLabel("Your name").fill(name);
  await other.getByRole("button", { name: "Use a password instead" }).click();
  await other.getByLabel("Password").fill("a perfectly long password");
  await other.getByRole("button", { name: "Join" }).click();
  await expect(other.getByRole("heading", { level: 1 })).toHaveText("Review");
  return { context, page: other };
}

test("make a team, add someone, and share with it from a phone", async ({ page, browser }, info) => {
  const run = `${info.project.name}${info.repeatEachIndex}`;
  const slug = `team-work-${run}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Only people added" }).click();
  await expect(page.getByRole("button", { name: "Only people added" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const sam = await join(page, browser, info.project.name, `sam-team-${run}@example.com`, `Sam ${run}`);
  await sam.page.goto(`/camerabuddy/${slug}`);
  await expect(sam.page.getByRole("heading", { level: 1 })).not.toHaveText(`Roadmap ${slug}`);

  await page.goto("/settings/teams");
  await page.getByRole("button", { name: "New team" }).click();
  await page.getByLabel("Name").fill(`Design ${run}`);
  await page.getByLabel("What it's for").fill("The people who review the mocks");
  await shot(page, info.project.name, "08-2-new-team");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Design ${run}`);

  await page.getByLabel("Add a person").fill(`sam-team-${run}`);
  await page.getByRole("button", { name: `Sam ${run}` }).click();
  await expect(page.locator(".group .li").getByText(`Sam ${run}`)).toBeVisible();
  await shot(page, info.project.name, "08-3-team");

  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByLabel("Add a person, team or email").fill(`Design ${run}`);
  await page.getByRole("button", { name: new RegExp(`^Design ${run}`) }).click();
  await expect(
    page
      .locator(".sheet")
      .getByRole("link", { name: `Design ${run}` })
      .first(),
  ).toBeVisible();
  await expect(page.locator(".sheet").getByText(`Sam ${run}`)).toBeVisible();
  await expect(page.locator(".sheet").getByText("Can comment, via")).toBeVisible();
  await shot(page, info.project.name, "08-4-share-with-team");

  await sam.page.goto(`/camerabuddy/${slug}`);
  await expect(sam.page.getByRole("heading", { level: 1 })).toHaveText(`Roadmap ${slug}`);
  await sam.context.close();

  await page.goto("/settings/teams");
  await expect(page.getByText(`Design ${run}`)).toBeVisible();
  await shot(page, info.project.name, "08-1-teams");
});
