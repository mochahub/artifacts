import { expect, test } from "@playwright/test";
import { BoardFixture, checkout, seedBoard } from "./boards-real.ts";
import { auth, shot } from "./helpers.ts";
import { BASE_URL } from "./stack.ts";

test.use({ serviceWorkers: "block" });

test("agent attribution survives a real checkpoint and reload", async ({ page }) => {
  const board = new BoardFixture(checkout());
  await seedBoard(page, { relay: board });
  const current = await (await page.request.get(`/api/artifacts/${board.id}/board/objects?draft=1`)).json();
  const response = await page.request.post(`/api/artifacts/${board.id}/board/ops`, {
    headers: auth(),
    data: {
      epoch: current.epoch,
      bases: {},
      requestId: crypto.randomUUID(),
      agent: "Claude Code",
      ops: [
        {
          op: "add",
          ref: "$mock",
          object: {
            kind: "shape",
            shape: "rect",
            text: "Cart mock",
            label: "Cart mock",
            parent: null,
            pose: { x: 0, y: 330, w: 120, h: 200, angle: 0 },
            style: checkout().objects[3]?.style,
          },
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result.outcome).toBe("applied");
  const saved = await page.request.post(`/api/artifacts/${board.id}/board/checkpoint`, {
    headers: { Origin: BASE_URL },
    data: { epoch: current.epoch },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto(board.url);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".bed .cv.board[data-ready='1']")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Show who made each object" }).click();
  await expect(page.locator(`.bo[data-id="${result.ids.$mock}"] .bo-who.agent`)).toContainText("Claude");
  await shot(page, "18-6-board-who");
});
