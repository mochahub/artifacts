import { expect, type Response, test } from "@playwright/test";
import { auth, shot, token } from "./helpers.ts";
import { publishCopy } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });

test("a comment from elsewhere appears without a reload", async ({ page, request }, info) => {
  const slug = `rt-${info.project.name}`;
  publishCopy(slug, token());
  const isThreads = (response: Response) => response.url().endsWith("/threads");
  // The server subscribes before it answers, so once the stream has answered, a comment reaches it.
  const stream = page.waitForResponse((response) => response.url().includes("/api/events"));
  const loaded = page.waitForResponse(isThreads);
  await page.goto(`/camerabuddy/${slug}/plan`);
  await Promise.all([stream, loaded]);
  const artifact = await (
    await request.get(`/api/artifacts/by-slug/camerabuddy/${slug}`, { headers: auth() })
  ).json();
  const refreshed = page.waitForResponse(isThreads, { timeout: 4000 });
  const posted = await request.post(`/api/artifacts/${artifact.id}/threads`, {
    headers: auth(),
    data: { pageKey: "plan", version: 1, anchor: null, body: "Seen from another device", agent: "Claude" },
  });
  expect(posted.ok()).toBe(true);
  // Faster than the 10-second poll, which is off while a stream is open.
  expect(await (await refreshed).text()).toContain("Seen from another device");
});

test("after a first comment on iPhone, the install sheet shows once", async ({ page }, info) => {
  test.skip(info.project.name !== "iphone", "the iPhone path");
  const slug = "install-prompt";
  publishCopy(slug, token());
  // Safari's real user agent: the test browser's doesn't say iPhone, and the sheet only shows there.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone) Safari" });
  });
  await page.goto(`/camerabuddy/${slug}/plan`);
  await page.evaluate(() => localStorage.removeItem("artifacts.install-asked"));
  await expect(page.locator("[data-block]").nth(2)).toBeVisible();
  const comment = async (text: string) => {
    await page.locator(".vbar").getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator("[data-block]").nth(2).click();
    const sheet = page.getByRole("dialog", { name: "New comment" });
    await sheet.getByLabel("Comment").fill(text);
    await sheet.getByRole("button", { name: "Post" }).click();
    await expect(sheet).toHaveCount(0);
  };
  await comment("First one");
  const prompt = page.getByRole("dialog", { name: "Get notified when an agent replies" });
  await expect(prompt.getByText("Add to Home Screen")).toBeVisible();
  await shot(page, "05-6-install");
  await prompt.getByRole("button", { name: "Not now" }).click();
  // The sheet is asked for in the same step that closes the comment, so once that's gone it would be up.
  await comment("Second one");
  await expect(prompt).toHaveCount(0);
});
