import { expect, test } from "@playwright/test";
import { join, shot, token } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

test("restrict a project: it says what happens, and it's gone for everyone else", async ({
  page,
  browser,
}, info) => {
  const run = `${info.project.name}${info.repeatEachIndex}`;
  const slug = `locked-${run}`;
  const project = `vault-${run}`;
  publishCopy(slug, token(), false, project);
  const nora = await join(page, browser, `nora-${run}@example.com`, `Nora ${run}`);
  const kai = await join(page, browser, `kai-${run}@example.com`, `Kai ${run}`);
  await nora.page.goto(`/${project}/${slug}`);
  await expect(nora.page.getByRole("heading", { level: 1 })).toHaveText(`Roadmap ${slug}`);

  await page.goto(`/${project}`);
  await expect(page.getByText("Everyone in Mochahub")).toBeVisible();
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByLabel("Add a person, team or email").fill(`kai-${run}`);
  await page.getByRole("button", { name: `Kai ${run}` }).click();
  await expect(page.getByRole("dialog").getByText(`Kai ${run}`)).toBeVisible();
  await page.getByRole("button", { name: "Only people added" }).click();
  await expect(page.getByText(/access, including/)).toBeVisible();
  await shot(page, "09-2-restrict");
  await page.getByRole("button", { name: /^Restrict / }).click();
  await expect(page.getByRole("button", { name: "Only people added" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await shot(page, "09-1-project-share");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Restricted")).toBeVisible();

  await nora.page.goto(`/${project}/${slug}`);
  await expect(nora.page.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
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

// Not changed here: the restrict test above counts on new projects being visible to everyone meanwhile.
test("organization settings show who new projects are visible to", async ({ page }) => {
  await page.goto("/settings/org");
  await expect(page.getByText("New projects are visible to")).toBeVisible();
  const restricted = page.getByRole("button", { name: "Only people added" });
  // Its own pair of choices: another setting on the page offers Organization too.
  const org = restricted.locator("..").getByRole("button", { name: "Organization" });
  await expect(org).toHaveAttribute("aria-pressed", "true");
  await expect(restricted).toHaveAttribute("aria-pressed", "false");
});
