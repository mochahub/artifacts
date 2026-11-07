import { expect, test } from "@playwright/test";
import { token } from "./helpers.ts";
import { publishFixture } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

test("an article's theme stays inside its body, and its components draw", async ({ page }, info) => {
  const slug = `themed-${info.project.name}`;
  publishFixture("themed-article", slug, token());
  await page.goto(`/demo/${slug}/doc`);
  const stat = page.locator('[data-component="stats"] strong').first();
  await expect(stat).toHaveText("41%");
  await expect(stat).toHaveCSS("border-top-color", "rgb(0, 163, 108)");
  const scoped = await page.evaluate(() => {
    const body = document.querySelector("[data-block]")?.parentElement as HTMLElement;
    return {
      body: body.style.getPropertyValue("--theme-accent"),
      article: (document.querySelector(".article") as HTMLElement).style.getPropertyValue("--theme-accent"),
      root: getComputedStyle(document.documentElement).getPropertyValue("--theme-accent"),
    };
  });
  expect(scoped).toEqual({ body: "#00a36c", article: "", root: "" });
});

test("a brand can be set by hand, previewed, and brought back later", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "it changes the whole org, so one project at a time");
  const name = "Acme";
  await page.goto("/settings/brand");
  await expect(page.getByRole("heading", { name: "Brand", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy the prompt" }).waitFor();

  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("textbox", { name: "Accent, as a hex colour" }).fill("d2452d");
  await page.getByLabel("Headings").selectOption("serif");
  await page.getByRole("button", { name: "Round" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const action = page.getByText("Primary action");
  await expect(action).toHaveCSS("background-color", "rgb(210, 69, 45)");
  await expect(action).toHaveCSS("border-radius", "20px");
  // The preview is scoped: the page around it keeps its own look.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--art-accent")),
  ).toBe("");
  await page.getByText("More colours").click();
  await page.getByRole("textbox", { name: "Text, as a hex colour", exact: true }).fill("#dddddd");
  await expect(page.getByText("Text will be hard to read")).toBeVisible();
  await page.getByRole("textbox", { name: "Text, as a hex colour", exact: true }).fill("");

  await page.getByRole("button", { name: /Use this brand|Save changes/ }).click();
  await expect(page.getByText(`Templates use ${name}.`)).toBeVisible();
  const row = page.locator(".li", { hasText: name });
  await expect(row.getByText("Current")).toBeVisible();

  await page.getByRole("button", { name: "Go back to the default" }).click();
  await expect(page.getByText("Templates use their own look.")).toBeVisible();
  await row.getByRole("button", { name: "Apply" }).click();
  await expect(row.getByText("Current")).toBeVisible();
  await page.getByRole("button", { name: "Go back to the default" }).click();
  await expect(row.getByRole("button", { name: "Apply" })).toBeVisible();
});
