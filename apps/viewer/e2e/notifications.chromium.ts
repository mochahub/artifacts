import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { publishCopy } from "./seed.ts";

test.use({ storageState: "e2e/.auth.json" });

/** Runs the worker's real click handler. Chromium can't tap a notification, so the event is stood in for. */
const tap = (page: Page, url: string) =>
  page
    .context()
    .serviceWorkers()[0]
    ?.evaluate((path) => {
      const event = Object.assign(new Event("notificationclick"), {
        notification: { close: () => {}, data: { url: path } },
        waitUntil: () => {},
      });
      self.dispatchEvent(event);
    }, url);

test("tapping a notification moves an app that's already open", async ({ page, request }) => {
  const token = readFileSync("e2e/.token", "utf8").trim();
  publishCopy("tapped", token);
  const headers = { Authorization: `Bearer ${token}` };
  const artifact = await (await request.get("/api/artifacts/by-slug/camerabuddy/tapped", { headers })).json();
  const thread = (body: string) =>
    request.post(`/api/artifacts/${artifact.id}/threads`, {
      headers,
      data: { pageKey: "plan", version: 1, anchor: null, body },
    });
  await thread("First");
  await thread("Second");

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await page.evaluate(() => {
    (window as unknown as { samePage: boolean }).samePage = true;
  });
  await tap(page, "/camerabuddy/tapped/plan?c=1");
  await expect(page).toHaveURL(/\/camerabuddy\/tapped\/plan\?c=1$/);
  const first = page.getByRole("dialog", { name: "Comment 1" });
  await expect(first).toBeVisible();

  // Another thread on the page it's already on.
  await first.getByRole("button", { name: "Close" }).click();
  await tap(page, "/camerabuddy/tapped/plan?c=2");
  const second = page.getByRole("dialog", { name: "Comment 2" });
  await expect(second).toBeVisible();

  // A second reply in a thread has the same link as the first.
  await second.getByRole("button", { name: "Close" }).click();
  await tap(page, "/camerabuddy/tapped/plan?c=2");
  await expect(second).toBeVisible();

  // A tap the app only finds later, as when iOS shows it before the worker runs and the message is lost.
  await second.getByRole("button", { name: "Close" }).click();
  await page.evaluate(async () => {
    const note = JSON.stringify({ url: "/activity", at: Date.now() });
    await (await caches.open("shell-v1")).put("/tapped-notification", new Response(note));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page).toHaveURL(/\/activity$/);

  // The app moved itself: a reload would have lost this.
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBe(true);
  const left = await page.evaluate(async () => (await caches.open("shell-v1")).match("/tapped-notification"));
  expect(left).toBeFalsy();
});
