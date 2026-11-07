import { expect, request, test } from "@playwright/test";

test("connect an app: the consent screen says who and what, and a decision goes back to the client", async ({
  page,
  baseURL,
}) => {
  // A client has no cookie, and one with a cookie but no Origin is what the CSRF guard refuses.
  const client = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const registered = await client.post("/api/oauth/register", {
    data: { client_name: "Scripted client", redirect_uris: ["http://127.0.0.1:17777/callback"] },
  });
  const { client_id: clientId } = await registered.json();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:17777/callback",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "s1",
  });
  const resource = new URL("/api/mcp", await page.request.get("/api/meta").then((r) => r.url())).href;
  query.set("resource", resource);
  await page.goto(`/api/oauth/authorize?${query}`);
  await expect(page.getByRole("heading", { name: "Connect an app" })).toBeVisible();
  await expect(page.getByText('calling itself "Scripted client"')).toBeVisible();
  await expect(page.getByText("127.0.0.1:17777")).toBeVisible();
  await expect(page.getByText("Search and read what you can see")).toBeVisible();
  await expect(page.getByText("It can't resolve threads")).toBeVisible();
  const leaving = page.waitForRequest((request) =>
    request.url().startsWith("http://127.0.0.1:17777/callback"),
  );
  await page.route("http://127.0.0.1:17777/**", (route) => route.fulfill({ status: 200, body: "done" }));
  await page.getByRole("button", { name: "Don't connect" }).click();
  const url = new URL((await leaving).url());
  expect(url.searchParams.get("error")).toBe("access_denied");
  expect(url.searchParams.get("state")).toBe("s1");
});
