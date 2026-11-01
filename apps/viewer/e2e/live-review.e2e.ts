import { readFileSync } from "node:fs";
import { expect, request, test } from "@playwright/test";
import { publishCopy, publishFixture } from "./seed.ts";

test.describe.configure({ timeout: 120_000 });
const token = () => readFileSync("e2e/.token", "utf8").trim();
const auth = () => ({ Authorization: `Bearer ${token()}` });

test("a comment from elsewhere appears without a reload", async ({ page, request }, info) => {
  const slug = `rt-${info.project.name}`;
  publishCopy(slug, token());
  const stream = page.waitForResponse((response) => response.url().includes("/api/events"));
  await page.goto(`/camerabuddy/${slug}/plan`);
  await stream;
  const artifact = await (
    await request.get(`/api/artifacts/by-slug/camerabuddy/${slug}`, { headers: auth() })
  ).json();
  await page.waitForTimeout(400);
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/threads"), {
    timeout: 4000,
  });
  const posted = await request.post(`/api/artifacts/${artifact.id}/threads`, {
    headers: auth(),
    data: { pageKey: "plan", version: 1, anchor: null, body: "Seen from another device", agent: "Claude" },
  });
  expect(posted.ok()).toBe(true);
  // Faster than the 10-second poll, which is off while a stream is open.
  await refreshed;
});

test("search finds an artifact from the Search tab", async ({ page }, info) => {
  const slug = `find-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto("/search");
  await page.getByLabel("Search").fill(`Roadmap ${slug}`);
  await page
    .locator(".li")
    .filter({ hasText: `Roadmap ${slug}` })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/camerabuddy/${slug}`));
});

test("search finds words inside an article, and opens that page", async ({ page }, info) => {
  const slug = `words-${info.project.name}`;
  publishCopy(slug, token());
  await page.goto("/search");
  await page.getByLabel("Search").fill("plain and short");
  const hit = page
    .locator(".li")
    .filter({ hasText: `Roadmap ${slug}` })
    .first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/camerabuddy/${slug}/research-`));
});

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

test("Settings shows the brand, and says how one gets proposed", async ({ page }) => {
  await page.goto("/settings/brand");
  await expect(page.getByRole("heading", { name: "Brand" })).toBeVisible();
  await expect(page.getByText("artifacts brand propose")).toBeVisible();
});

test("⌘K opens search anywhere", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboards only");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
});

test("a gallery opens into a lightbox and steps through", async ({ page }, info) => {
  const slug = `gal-${info.project.name}`;
  publishFixture("gallery", slug, token());
  await page.goto(`/demo/${slug}/photos`);
  await page.getByRole("button", { name: "Second take" }).click();
  const light = page.getByRole("dialog", { name: "Second take" });
  await expect(light).toBeVisible();
  await light.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "First light" })).toBeVisible();
  await page.screenshot({
    path: `../../docs/mocks/shots/${info.project.name === "iphone" ? "" : "desktop-"}gallery.png`,
  });
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".light")).toHaveCount(0);
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
  await page.screenshot({
    path: `../../docs/mocks/shots/${info.project.name === "iphone" ? "" : "desktop-"}compare-changes.png`,
  });
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
  await page.screenshot({ path: "../../docs/mocks/shots/05-6-install.png" });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await comment("Second one");
  await page.waitForTimeout(300);
  await expect(prompt).toHaveCount(0);
});

test("connect an app: the consent screen says who and what, and a decision goes back to the client", async ({
  page,
  baseURL,
}) => {
  // A client has no cookie, and one with a cookie but no Origin is what the CSRF guard refuses.
  const client = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const registered = await client.post("/api/oauth/register", {
    data: { client_name: "Scripted client", redirect_uris: ["http://127.0.0.1:9/callback"] },
  });
  const { client_id: clientId } = await registered.json();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9/callback",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "s1",
  });
  const resource = new URL("/api/mcp", await page.request.get("/api/meta").then((r) => r.url())).href;
  query.set("resource", resource);
  await page.goto(`/api/oauth/authorize?${query}`);
  await expect(page.getByRole("heading", { name: "Connect an app" })).toBeVisible();
  await expect(page.getByText('calling itself "Scripted client"')).toBeVisible();
  await expect(page.getByText("127.0.0.1:9")).toBeVisible();
  await expect(page.getByText("Search and read what you can see")).toBeVisible();
  await expect(page.getByText("It can't resolve threads")).toBeVisible();
  const leaving = page.waitForRequest((request) => request.url().startsWith("http://127.0.0.1:9/callback"));
  await page.route("http://127.0.0.1:9/**", (route) => route.fulfill({ status: 200, body: "done" }));
  await page.getByRole("button", { name: "Don't connect" }).click();
  const url = new URL((await leaving).url());
  expect(url.searchParams.get("error")).toBe("access_denied");
  expect(url.searchParams.get("state")).toBe("s1");
});
