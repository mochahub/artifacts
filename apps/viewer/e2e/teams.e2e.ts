import { expect, test } from "@playwright/test";
import { join, shot, token } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

test("make a team, add someone, and share with it from a phone", async ({ page, browser }, info) => {
  const run = `${info.project.name}${info.repeatEachIndex}`;
  const slug = `team-work-${run}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Only people added" }).click();
  await expect(page.getByRole("button", { name: "Only people added" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const sam = await join(page, browser, `sam-team-${run}@example.com`, `Sam ${run}`);
  await sam.page.goto(`/camerabuddy/${slug}`);
  await expect(sam.page.getByRole("heading", { level: 1 })).toHaveText("Nothing here");

  await page.goto("/settings/teams");
  await page.getByRole("button", { name: "New team" }).click();
  await page.getByLabel("Name").fill(`Design ${run}`);
  await page.getByLabel("What it's for").fill("The people who review the mocks");
  await shot(page, "08-2-new-team");
  await page.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Design ${run}`);

  await page.getByLabel("Add a person").fill(`sam-team-${run}`);
  await page.getByRole("button", { name: `Sam ${run}` }).click();
  await expect(page.getByRole("main").getByText(`Sam ${run}`)).toBeVisible();
  await shot(page, "08-3-team");

  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByLabel("Add a person, team or email").fill(`Design ${run}`);
  await page.getByRole("button", { name: new RegExp(`^Design ${run}`) }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: `Design ${run}` }).first()).toBeVisible();
  await expect(sheet.getByText(`Sam ${run}`)).toBeVisible();
  await expect(sheet.getByText("Can comment, via")).toBeVisible();
  await shot(page, "08-4-share-with-team");

  await sam.page.goto(`/camerabuddy/${slug}`);
  await expect(sam.page.getByRole("heading", { level: 1 })).toHaveText(`Roadmap ${slug}`);
  await sam.context.close();

  await page.goto("/settings/teams");
  await expect(page.getByText(`Design ${run}`)).toBeVisible();
  await shot(page, "08-1-teams");
});
