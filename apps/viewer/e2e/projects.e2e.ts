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

test("restrict a project: it says what happens, and it's gone for everyone else", async ({
  page,
  browser,
}, info) => {
  const run = `${info.project.name}${info.repeatEachIndex}`;
  const slug = `locked-${run}`;
  const project = `vault-${run}`;
  publishCopy(slug, token(), false, project);
  const nora = await join(page, browser, info.project.name, `nora-${run}@example.com`, `Nora ${run}`);
  const kai = await join(page, browser, info.project.name, `kai-${run}@example.com`, `Kai ${run}`);
  await nora.page.goto(`/${project}/${slug}`);
  await expect(nora.page.getByRole("heading", { level: 1 })).toHaveText(`Roadmap ${slug}`);

  await page.goto(`/${project}`);
  await expect(page.getByText("Everyone in Mochahub")).toBeVisible();
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByLabel("Add a person, team or email").fill(`kai-${run}`);
  await page.getByRole("button", { name: `Kai ${run}` }).click();
  await expect(page.locator(".sheet .group .li").getByText(`Kai ${run}`)).toBeVisible();
  await page.getByRole("button", { name: "Only people added" }).click();
  await expect(page.getByText(/access, including/)).toBeVisible();
  await shot(page, info.project.name, "09-2-restrict");
  await page.getByRole("button", { name: /^Restrict / }).click();
  await expect(page.getByRole("button", { name: "Only people added" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await shot(page, info.project.name, "09-1-project-share");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Restricted")).toBeVisible();

  await nora.page.goto(`/${project}/${slug}`);
  await expect(nora.page.getByRole("heading", { level: 1 })).not.toHaveText(`Roadmap ${slug}`);
  await nora.page.goto("/projects");
  await expect(nora.page.getByRole("heading", { level: 1 })).toHaveText("Projects");
  await expect(nora.page.getByRole("link", { name: new RegExp(project) })).toHaveCount(0);
  await kai.page.goto(`/${project}/${slug}`);
  await expect(kai.page.getByRole("heading", { level: 1 })).toHaveText(`Roadmap ${slug}`);

  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Org", exact: true }).click();
  await expect(page.getByRole("button", { name: "Org", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await nora.context.close();
  await kai.context.close();
});

test("the setting for new projects sticks", async ({ page }) => {
  await page.goto("/settings/org");
  await expect(page.getByText("New projects are visible to")).toBeVisible();
});
