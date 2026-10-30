import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { publishCopy } from "./seed.ts";

const shot = async (page: Page, project: string, name: string) => {
  if (project === "iphone") await page.screenshot({ path: `../../docs/mocks/shots/${name}.png` });
};
test.describe.configure({ timeout: 120_000 });

const token = () => readFileSync("e2e/.token", "utf8");

test("archive shows the banner and stops comments; unarchive undoes it", async ({ page }, info) => {
  const slug = `arch-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await shot(page, info.project.name, "07-1-menu");
  await page.getByRole("button", { name: /^Archive/ }).click();
  await expect(page.getByText(/^Archived on .*Read-only\.$/)).toBeVisible();
  await shot(page, info.project.name, "07-5-archived");
  await page.goto(`/camerabuddy/${slug}/plan`);
  await expect(page.locator(".vbar").getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await page.goto("/camerabuddy");
  await page.getByRole("button", { name: "Archived" }).click();
  await expect(page.locator(".tile")).toHaveCount(1);
  await shot(page, info.project.name, "07-4-archived-filter");
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByText(/^Archived on/)).toHaveCount(0);
});

test("delete, the deleted link, Recently deleted and restore", async ({ page }, info) => {
  const slug = `del-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByText("Share links stop now")).toBeVisible();
  await shot(page, info.project.name, "07-2-delete");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/camerabuddy$/);

  await page.goto(`/camerabuddy/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This artifact was deleted");
  await shot(page, info.project.name, "07-6-deleted-link");

  await page.goto("/settings/deleted");
  await expect(page.getByText("30 days left").first()).toBeVisible();
  await shot(page, info.project.name, "07-3-recently-deleted");
  await page.getByRole("button", { name: "Delete all now" }).click();
  await expect(page.getByRole("dialog").getByText("This can't be undone.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await page.goto(`/camerabuddy/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Camera Buddy roadmap");
});

test("version history: preview, name, restore and compare", async ({ page }, info) => {
  const slug = `ver-${info.project.name}`;
  publishCopy(slug, token(), true);
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "Version history" }).click();
  const sheet = page.getByRole("dialog", { name: "Version history" });
  await sheet.getByRole("button", { name: /^v1/ }).click();
  await shot(page, info.project.name, "01-6-version-open");
  await sheet.getByRole("button", { name: "Name" }).click();
  await sheet.getByLabel("Version name").fill("First draft");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByText("First draft")).toBeVisible();
  await sheet.getByRole("link", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("v1 and v2");
  await expect(page.getByText("mocks/live-view")).toBeVisible();

  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "Version history" }).click();
  await sheet.getByRole("button", { name: /^v1/ }).click();
  await sheet.getByRole("button", { name: "Restore" }).click();
  await expect(sheet).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("v3", { exact: true })).toBeVisible();
});

test("activity lists what happened, and filters", async ({ page }, info) => {
  await page.goto("/activity");
  await expect(page.getByText(/published Camera Buddy roadmap/).first()).toBeVisible();
  await shot(page, info.project.name, "05-5-activity");
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.locator(".av.agent").first()).toBeVisible();
});
