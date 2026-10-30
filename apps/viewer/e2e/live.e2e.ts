import { readFileSync } from "node:fs";
import { type Browser, expect, type FrameLocator, test } from "@playwright/test";
import { publishFixture } from "./seed.ts";

test.describe.configure({ timeout: 120_000, mode: "serial" });
const token = () => readFileSync("e2e/.token", "utf8");
const slugFor = (project: string) => `poll-${project}`;

const live = (page: { frameLocator(selector: string): FrameLocator }) => page.frameLocator("iframe.live");
const stranger = (browser: Browser) => browser.newContext({ storageState: { cookies: [], origins: [] } });

test("the poll works with no backend; shared counts add up and me stays personal", async ({
  page,
  browser,
}, info) => {
  const slug = slugFor(info.project.name);
  publishFixture("micro-app-poll", slug, token());
  await page.goto(`/demo/${slug}/poll`);
  const frame = live(page);
  await frame.getByRole("button", { name: /^A/ }).click();
  await expect(frame.getByText("You picked A")).toBeVisible();
  await expect(frame.locator("#count-a")).toHaveText("1");
  await expect(page.getByText("Saved for")).toBeVisible();

  // A second person, by a comment link: their own `me`, the same `shared`.
  await page.goto(`/demo/${slug}`);
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Copy link" }).click();
  const url = (await page.getByTestId("share-url").textContent()) as string;
  const context = await stranger(browser);
  const guest = await context.newPage();
  await guest.goto(url);
  await guest.getByLabel("Your name").fill("Riley");
  await guest.getByRole("button", { name: "Start reviewing" }).click();
  await expect(guest).toHaveURL(new RegExp(`/demo/${slug}$`));
  await guest.goto(`/demo/${slug}/poll`);
  const theirs = live(guest);
  await expect(theirs.getByText("Pick one")).toBeVisible();
  await theirs.getByRole("button", { name: /^B/ }).click();
  await expect(theirs.getByText("You picked B")).toBeVisible();
  await expect(theirs.locator("#count-a")).toHaveText("1");
  await expect(theirs.locator("#count-b")).toHaveText("1");
  await context.close();

  await page.goto(`/demo/${slug}/poll`);
  await expect(live(page).getByText("You picked A")).toBeVisible();
  await expect(live(page).locator("#count-b")).toHaveText("1");
});

test("Try it swaps a frame for its live page, and Done puts the picture back", async ({ page }, info) => {
  const slug = slugFor(info.project.name);
  await page.goto(`/demo/${slug}/frames#frame=poll`);
  await expect(page.locator(".capsule b")).toHaveText("Poll");
  await page.getByRole("button", { name: "Try it" }).click();
  const iframe = page.locator(".fr iframe.live");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(live(page).getByRole("heading", { name: "Which direction?" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(iframe).toHaveCount(0);
});

test("the bridge ignores other windows, and a frame can't name another artifact", async ({ page }, info) => {
  const slug = slugFor(info.project.name);
  await page.goto(`/demo/${slug}/poll`);
  await expect(live(page).getByRole("heading", { name: "Which direction?" })).toBeVisible();
  const answered = await page.evaluate(
    () =>
      new Promise<boolean>((done) => {
        const spy = document.createElement("iframe");
        spy.sandbox.add("allow-scripts");
        spy.srcdoc = `<script>addEventListener("message",(e)=>{if(e.data&&e.data.id==="spy")parent.postMessage("answered","*")});
          parent.postMessage({artifacts:1,id:"spy",op:{kind:"get",scope:"shared",key:"votes"}},"*")</script>`;
        addEventListener("message", (event) => {
          if (event.data === "answered") done(true);
        });
        document.body.append(spy);
        setTimeout(() => done(false), 800);
      }),
  );
  expect(answered).toBe(false);
});

test("the poll with a backend: votes stay hidden, totals come back", async ({ page }, info) => {
  const slug = `poll-b-${info.project.name}`;
  publishFixture("micro-app-poll-backend", slug, token());
  await page.goto(`/demo/${slug}/poll`);
  const frame = live(page);
  await frame.getByRole("button", { name: /^B/ }).click();
  await expect(frame.getByText("You picked B")).toBeVisible();
  await expect(frame.locator("#count-b")).toHaveText("1");
  await page.reload();
  await expect(live(page).getByText("You picked B")).toBeVisible();
});
