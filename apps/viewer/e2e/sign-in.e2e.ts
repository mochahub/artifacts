import { expect, test } from "@playwright/test";
import { OWNER, signIn, watchErrors } from "./helpers.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test("sign in, and stay signed in across a reload", async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  if (info.project.name === "iphone")
    await page.screenshot({ path: "../../docs/mocks/shots/06-2-sign-in.png" });
  // The heading paints before the effects that fetch, and WebKit reports a fetch begun while the page
  // unloads as an access control failure. Once the page has its data, those effects have run.
  const loaded = Promise.all(
    ["/api/home", "/api/projects"].map((path) =>
      page.waitForResponse((response) => new URL(response.url()).pathname === path && response.ok()),
    ),
  );
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await loaded;
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  expect(errors).toEqual([]);
});

test("a wrong password says so", async ({ page }) => {
  await signIn(page, "nobody@example.com", "wrong password here");
  await expect(page.getByText("That email or password isn't right.")).toBeVisible();
});

test("the field text is big enough that Safari won't zoom", async ({ page }) => {
  await page.goto("/sign-in");
  const size = await page
    .getByLabel("Email")
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
});

test("the router shows Nothing here on an unknown route", async ({ page }) => {
  await page.goto("/no/such/route/here");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing here");
});

test("approve the CLI by typing its code", async ({ page, request }, info) => {
  const errors = watchErrors(page);
  const start = await request.post("/api/device/start", {
    data: { clientName: "Sam's MacBook Pro", agent: "Claude Code" },
  });
  const { userCode, deviceCode } = await start.json();

  await page.goto("/device");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/device$/);

  await page.getByLabel("Code").fill(userCode.toLowerCase());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approve the CLI?");
  await expect(page.getByText("Sam's MacBook Pro")).toBeVisible();
  await expect(page.getByText(userCode)).toBeVisible();
  if (info.project.name === "iphone")
    await page.screenshot({ path: "../../docs/mocks/shots/06-7-approve-cli.png" });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Approved");

  const poll = await request.post("/api/device/poll", { data: { deviceCode } });
  expect((await poll.json()).status).toBe("approved");
  expect(errors).toEqual([]);
});
