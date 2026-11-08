import { expect, test } from "@playwright/test";
import { BoardFixture, checkout, firePointer, screenOf, seedBoard } from "./boards-real.ts";
import { BASE_URL } from "./stack.ts";

declare global {
  interface Window {
    boardDelivery: { hold: boolean; queued: (() => void)[] };
  }
}

test.use({ serviceWorkers: "block" });

test("Done remounts the unchanged checkpoint without a reload", async ({ page }) => {
  const relay = new BoardFixture(checkout());
  await seedBoard(page, { relay });
  await page.goto(relay.url);
  await expect(page.locator(".cv.board .bo")).toHaveCount(9);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.locator(".bed .cv[data-ready='1']")).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".cv.board .bo")).toHaveCount(9);
    await expect.poll(() => page.locator(".cv .world").getAttribute("data-s")).not.toBeNull();
  }
});

test("reader completes agent checkpoint pictures and a newly posted object crop", async ({ page }) => {
  const relay = new BoardFixture(checkout());
  await seedBoard(page, { relay });
  const base = `/api/artifacts/${relay.id}/board`;
  const snapshot = async () => (await page.request.get(`${base}/snapshot?version=2`)).json();
  expect((await snapshot()).renders).toBeNull();
  await page.goto(relay.url);
  await expect.poll(async () => (await snapshot()).renders?.thumbnail?.hash).toBeTruthy();
  const originalThumbnail = (await snapshot()).renders.thumbnail.hash;
  const object = (await relay.board()).objects[0];
  if (!object) throw new Error("Fixture has no objects");
  const response = await page.request.post(`/api/artifacts/${relay.id}/threads`, {
    headers: { Origin: BASE_URL },
    data: {
      pageKey: "board",
      version: 2,
      body: "Picture this",
      anchor: { type: "object", object: object.id, u: 0.5, v: 0.5, checkpoint: 2 },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const thread = await response.json();
  await page.reload();
  await expect
    .poll(async () =>
      (await snapshot()).renders?.crops.some((crop: { thread: number }) => crop.thread === thread.n),
    )
    .toBe(true);
  expect((await snapshot()).renders.thumbnail.hash).toBe(originalThumbnail);
});

test("Save waits for delayed local socket delivery before checkpointing", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = WebSocket;
    const state = { hold: false, queued: [] as (() => void)[] };
    Object.assign(window, { boardDelivery: state });
    window.WebSocket = class extends Native {
      send(data: Parameters<WebSocket["send"]>[0]) {
        if (state.hold) state.queued.push(() => super.send(data));
        else super.send(data);
      }
    };
  });
  const relay = new BoardFixture(checkout());
  await seedBoard(page, { relay });
  await page.goto(relay.url);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".bed .cv[data-ready='1']")).toBeVisible();
  await page.evaluate(() => {
    window.boardDelivery.hold = true;
  });
  await page.getByRole("button", { name: "Sticky", exact: true }).click();
  const at = await screenOf(page, 120, 420);
  await firePointer(page, "pointerdown", at.x, at.y, "mouse", 1);
  await firePointer(page, "pointerup", at.x, at.y, "mouse", 1);
  await page.getByRole("textbox", { name: "Text", exact: true }).fill("Persist before save");
  await page.getByRole("textbox", { name: "Text", exact: true }).blur();
  let captures = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/captures")) captures++;
  });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Save version" }).click();
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.getByRole("button", { name: "Syncing and saving" })).toBeVisible();
  expect(captures).toBe(0);
  await page.evaluate(() => {
    const state = window.boardDelivery;
    state.hold = false;
    for (const send of state.queued.splice(0)) send();
  });
  await expect(page.getByRole("button", { name: "Syncing and saving" })).toHaveCount(0);
  const response = await page.request.get(`/api/artifacts/${relay.id}/board/snapshot?version=3`);
  expect(response.ok(), await response.text()).toBe(true);
  expect(
    (await response.json()).snapshot.objects.some(
      (object: { text?: string }) => object.text === "Persist before save",
    ),
  ).toBe(true);
});
