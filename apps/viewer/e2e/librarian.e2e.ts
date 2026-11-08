import { expect, test } from "@playwright/test";
import { overflowsSideways } from "./helpers.ts";

test.use({ serviceWorkers: "block" });

const wikiId = "11111111-1111-4111-8111-111111111111";
const config = {
  enabled: false,
  generation: 0,
  wikiIds: [wikiId],
  model: "mock-private",
  monthlyLimitMicrousd: 25000000,
  runLimitMicrousd: 1000000,
  keyConfigured: false,
  keyGeneration: 0,
  updatedAt: "2026-11-07T00:00:00Z",
};
test("librarian stays off, key is write-only, lazy settings fit phone and desktop", async ({
  page,
}, info) => {
  let state = { ...config };
  const writes: unknown[] = [];
  await page.route("**/api/projects", (r) =>
    r.fulfill({ json: [{ id: wikiId, slug: "private-wiki", name: "Private wiki", kind: "wiki" }] }),
  );
  await page.route("**/api/librarian/config", async (r) => {
    if (r.request().method() === "PUT") {
      const body = r.request().postDataJSON();
      writes.push(body);
      state = { ...state, ...body, generation: state.generation + 1 };
    }
    await r.fulfill({ json: state });
  });
  await page.route("**/api/librarian/key", async (r) => {
    expect(r.request().postDataJSON().key).toBe("synthetic-private-key");
    state = { ...state, keyConfigured: true, generation: state.generation + 1 };
    await r.fulfill({ status: 204 });
  });
  await page.goto("/settings/librarian");
  await expect(page.getByText("Librarian is off", { exact: true })).toBeVisible();
  await page.getByLabel("New provider key").fill("synthetic-private-key");
  await page.getByRole("button", { name: "Save key, keep off", exact: true }).click();
  await expect(page.getByLabel("New provider key")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("synthetic-private-key");
  await expect(page.getByText("Key saved. Librarian is off.")).toBeVisible();
  await page.getByRole("button", { name: "Save setup, keep off" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ enabled: false, wikiIds: [wikiId] });
  expect(await overflowsSideways(page)).toBe(false);
  await page.screenshot({ path: info.outputPath("librarian-settings.png"), fullPage: true });
});
test("shared source requires explicit wiki and confirmation, queue accepts while off", async ({
  page,
}, info) => {
  let submissions = 0;
  await page.route("**/api/projects", (r) =>
    r.fulfill({ json: [{ id: wikiId, slug: "private-wiki", name: "Private wiki", kind: "wiki" }] }),
  );
  await page.route("**/api/wikis/private-wiki/inbox", async (r) => {
    if (r.request().method() === "POST") {
      submissions++;
      expect(r.request().postDataJSON().source).toMatchObject({ kind: "text", text: "Shared private text" });
      await r.fulfill({ status: 202, json: { id: wikiId, message: "Saved to inbox. Librarian is off." } });
    } else await r.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/inbox/share?title=Private%20note&text=Shared%20private%20text");
  await expect(page.getByLabel("Text, up to 1 MiB")).toHaveValue("Shared private text");
  expect(submissions).toBe(0);
  await expect(page.getByRole("button", { name: "Add to queue" })).toBeDisabled();
  await page.getByLabel("Target wiki").selectOption("private-wiki");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved to inbox. Librarian is off.");
  expect(submissions).toBe(1);
  expect(await overflowsSideways(page)).toBe(false);
  await page.screenshot({ path: info.outputPath("librarian-inbox.png"), fullPage: true });
});
test("admin logs require recent authentication and never echo unsafe failures", async ({ page }) => {
  await page.route("**/api/librarian/runs", (r) =>
    r.fulfill({ status: 500, json: { error: { code: "invalid", message: "synthetic-provider-secret" } } }),
  );
  await page.goto("/settings/librarian/runs");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("synthetic-provider-secret");
});

test("non-admin settings and logs do not fetch admin data", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/me", (r) =>
    r.fulfill({ json: { person: { id: wikiId, name: "Private reviewer", role: "member" } } }),
  );
  await page.route("**/api/librarian/**", (r) => {
    reads++;
    return r.fulfill({ status: 403, json: {} });
  });
  await page.goto("/settings/librarian");
  await expect(page.getByText("Admin access required.")).toBeVisible();
  await page.goto("/settings/librarian/runs");
  await expect(page.getByText("Admin access required.")).toBeVisible();
  expect(reads).toBe(0);
});

test("recent-auth uses the existing confirmation sheet", async ({ page }) => {
  await page.route("**/api/librarian/config", (r) =>
    r.fulfill({
      status: 403,
      json: { error: { code: "recent_auth_required", message: "Confirm identity" } },
    }),
  );
  await page.goto("/settings/librarian");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Confirm it's you", { exact: true })).toBeVisible();
});

test("file and URL capture use queue endpoints without enabling", async ({ page }) => {
  const submissions: Record<string, unknown>[] = [];
  let uploaded = false;
  await page.route("**/api/projects", (r) =>
    r.fulfill({ json: [{ id: wikiId, slug: "private-wiki", name: "Private wiki", kind: "wiki" }] }),
  );
  await page.route("**/api/wikis/private-wiki/inbox/uploads", (r) =>
    r.fulfill({
      status: 201,
      json: {
        uploadId: wikiId,
        url: new URL("/private-upload", r.request().url()).href,
        headers: { "Content-Type": "text/plain" },
      },
    }),
  );
  await page.route("**/private-upload", async (r) => {
    uploaded = true;
    expect(r.request().method()).toBe("PUT");
    await r.fulfill({ status: 200 });
  });
  await page.route("**/api/wikis/private-wiki/inbox", async (r) => {
    if (r.request().method() === "POST") {
      submissions.push(r.request().postDataJSON().source);
      await r.fulfill({ status: 202, json: { message: "Saved to inbox. Librarian is off." } });
    } else await r.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/wikis/private-wiki/inbox");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByLabel("File, up to 10 MiB").setInputFiles({
    name: "private-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Private mock source"),
  });
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page.getByRole("status")).toContainText("Librarian is off");
  expect(uploaded).toBe(true);
  expect(submissions[0]).toMatchObject({ kind: "file", uploadId: wikiId });
  await page.getByRole("button", { name: "URL", exact: true }).click();
  await page.getByLabel("Public HTTPS URL").fill("https://example.test/private-mock");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]).toMatchObject({ kind: "url", url: "https://example.test/private-mock" });
});

test("run log and proposal review fit phone and desktop", async ({ page }, info) => {
  const proposalId = "22222222-2222-4222-8222-222222222222";
  await page.route("**/api/projects", (r) =>
    r.fulfill({ json: [{ id: wikiId, slug: "private-wiki", name: "Private wiki", kind: "wiki" }] }),
  );
  await page.route(`**/api/librarian/runs/${wikiId}`, (r) =>
    r.fulfill({
      json: {
        id: wikiId,
        wikiId,
        state: "waiting_human",
        model: "mock-private",
        startedAt: "2026-11-08T12:00:00Z",
        usage: { settledMicrousd: 800, uncertainMicrousd: 0, reservedMicrousd: 0 },
        result: { editRunIds: [], proposalIds: [proposalId], questionIds: [] },
      },
    }),
  );
  await page.route(`**/api/librarian/runs/${wikiId}/events`, (r) =>
    r.fulfill({
      json: {
        events: [{ id: proposalId, code: "waiting_human", createdAt: "2026-11-08T12:00:00Z" }],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/api/wikis/private-wiki/proposals/${proposalId}`, (r) =>
    r.fulfill({
      json: {
        id: proposalId,
        runId: wikiId,
        wikiId,
        title: "Source summary",
        summary: "Review the source before creating a page.",
        markdown: "# Source summary\n\nA proposed page from a private mock source.",
        sources: [],
        untrusted: true,
        status: "open",
      },
    }),
  );
  await page.goto(`/settings/librarian/runs/${wikiId}`);
  await expect(page.getByRole("link", { name: "Review proposed page" })).toBeVisible();
  expect(await overflowsSideways(page)).toBe(false);
  await page.screenshot({ path: info.outputPath("librarian-log.png"), fullPage: true });
  await page.getByRole("link", { name: "Review proposed page" }).click();
  await expect(page.getByRole("button", { name: "Create page", exact: true })).toBeVisible();
  await expect(page.getByText("Librarian proposal. Based on untrusted sources.")).toBeVisible();
  expect(await overflowsSideways(page)).toBe(false);
  await page.screenshot({ path: info.outputPath("librarian-proposal.png"), fullPage: true });
});
