import { expect, test } from "@playwright/test";
import { box, shot, token } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

test("archive shows the banner and stops comments; unarchive undoes it", async ({ page }, info) => {
  const slug = `arch-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await shot(page, "07-1-menu");
  await page.getByRole("button", { name: /^Archive/ }).click();
  await expect(page.getByText(/^Archived on .*Read-only\.$/)).toBeVisible();
  await shot(page, "07-5-archived");
  await page.goto(`/camerabuddy/${slug}/plan`);
  await expect(page.locator(".vbar").getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await page.goto("/camerabuddy");
  await page.getByRole("button", { name: "Archived" }).click();
  // The iPhone and desktop runs share a project, so this looks for its own.
  await expect(page.getByText(`Roadmap ${slug}`)).toBeVisible();
  await shot(page, "07-4-archived-filter");
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
  await shot(page, "07-2-delete");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/camerabuddy$/);

  await page.goto(`/camerabuddy/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This artifact was deleted");
  await shot(page, "07-6-deleted-link");
  // Every link to it says so, not only its front page (SPEC §5.5, "Its links").
  await page.goto(`/camerabuddy/${slug}/compare?from=1&to=1`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This artifact was deleted");

  await page.goto("/settings/deleted");
  const row = page.locator(".li").filter({ hasText: `Roadmap ${slug}` });
  await expect(row.getByText("30 days left")).toBeVisible();
  await shot(page, "07-3-recently-deleted");
  await page.getByRole("button", { name: "Delete all now" }).click();
  await expect(page.getByRole("dialog").getByText("This can't be undone.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(row).toHaveCount(0);
  await page.goto(`/camerabuddy/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Roadmap ${slug}`);
});

test("version history: preview, name, restore and compare", async ({ page }, info) => {
  const slug = `ver-${info.project.name}`;
  publishCopy(slug, token(), true);
  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Version history" }).click();
  const sheet = page.getByRole("dialog", { name: "Version history" });
  await sheet.getByRole("button", { name: /^v1/ }).click();
  await shot(page, "01-6-version-open");
  await sheet.getByRole("button", { name: "Name" }).click();
  await sheet.getByLabel("Version name").fill("First draft");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet.getByText("First draft")).toBeVisible();
  await sheet.getByRole("link", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("v1 and v2");
  await expect(page.locator(".tt", { hasText: "mocks/live-view" })).toBeVisible();

  await page.goto(`/camerabuddy/${slug}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Version history" }).click();
  await sheet.getByRole("button", { name: /^v1/ }).click();
  await sheet.getByRole("button", { name: "Restore" }).click();
  await expect(sheet).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("v3", { exact: true })).toBeVisible();
});

test("activity lists what happened, and filters", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByText(/published Camera Buddy roadmap/).first()).toBeVisible();
  await shot(page, "05-5-activity");
  // In the page's column, a filter that takes spare height swells whenever the list is short.
  expect((await box(page, ".seg")).h).toBeLessThan(52);
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.locator(".av.agent").first()).toBeVisible();
});

test("compare: side by side, swipe, and changes with numbered regions", async ({ page }, info) => {
  const slug = `cmp-${info.project.name}`;
  publishCopy(slug, token(), true);
  await page.goto(`/camerabuddy/${slug}/compare?from=1&to=2`);
  await expect(page.getByRole("button", { name: "Side by side" })).toBeVisible();
  await expect(page.locator(".diff .pair img").first()).toBeVisible();
  await page.getByRole("button", { name: "Swipe" }).click();
  await expect(page.locator(".diff .swipe input").first()).toBeVisible();
  await page.getByRole("button", { name: "Changes" }).click();
  await expect(page.locator(".diff .region").first()).toBeVisible();
  await shot(page, "compare-changes", { desktop: true });
});
