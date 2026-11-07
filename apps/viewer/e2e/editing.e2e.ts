import { existsSync } from "node:fs";
import type { Attribution, Author, DocState, Run, Suggestion } from "@artifacts/schema";
import { expect, type Page, test } from "@playwright/test";
import { auth, overflowsSideways, shot, signIn, watchErrors } from "./helpers.ts";

// The editing routes are answered here, so the editor's screens are tested whatever the server's state;
// the service worker would answer before these routes do.
test.use({ serviceWorkers: "block" });

const now = new Date().toISOString();
const later = new Date(Date.now() + 86_400_000).toISOString();
const AGENT: Author = {
  key: "a2",
  kind: "agent",
  name: "Claude Code",
  agent: "Claude Code",
  for: "Maya",
  sources: ["notes"],
};

function docState(over: Partial<DocState> = {}): DocState {
  return {
    editable: true,
    reason: null,
    canEdit: true,
    canAccept: true,
    canMaintain: true,
    version: 1,
    dirty: false,
    seq: 1,
    epoch: 1,
    updatedAt: now,
    agentMaintained: false,
    audience: { kind: "team", label: "Design team" },
    agents: { edits: "suggestion", reason: "audience", text: "Agents' edits arrive as suggestions." },
    present: [],
    openSuggestions: 0,
    runs: [],
    ...over,
  };
}

const suggestion = (over: Partial<Suggestion>): Suggestion => ({
  id: "00000000-0000-4000-8000-000000000001",
  op: "replace",
  block: null,
  newBlock: null,
  base: "0123456789ab",
  markdown: "Team is $14 a seat each month.",
  meta: null,
  html: "<p>Team is $14 a seat each month.</p>",
  note: "Matches the Q3 board notes: $14 from 1 January.",
  sources: ["notes"],
  fixes: [],
  status: "open",
  run: null,
  author: AGENT,
  createdAt: now,
  expiresAt: later,
  decidedAt: null,
  decidedBy: null,
  ...over,
});

/** A wiki page to edit: published through the MCP, as an agent would. */
async function seedPage(page: Page, wiki: string) {
  const request = page.request;
  expect(
    (await request.post("/api/wikis", { headers: auth(), data: { slug: wiki, name: "Design" } })).ok(),
  ).toBe(true);
  const response = await request.post("/api/mcp", {
    headers: { ...auth(), Accept: "application/json, text/event-stream" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "artifacts_publish_article",
        arguments: {
          project: wiki,
          slug: "pricing",
          title: "Pricing",
          summary: "How we charge.",
          markdown:
            "# Pricing\n\nWe charge per seat, not per artifact. A team of five pays the same whether it publishes ten artifacts a week or a hundred.\n\n## Plans\n\nFree covers one person and three projects. Team is $12 a seat each month and adds teams.\n\nAnnual billing takes two months off.",
        },
      },
    },
  });
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
  const artifact = await (await request.get(`/api/artifacts/by-slug/${wiki}/pricing`)).json();
  return artifact.id as string;
}

/** Answers the editing routes from these values; returns what was posted, by path. */
async function mockEditing(
  page: Page,
  id: string,
  values: { doc: () => DocState; suggestions?: () => Suggestion[]; authors?: () => Attribution },
) {
  const posted: Record<string, unknown[]> = {};
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route(`**/api/artifacts/${id}/doc`, (route) => route.fulfill(json(values.doc())));
  await page.route(`**/api/artifacts/${id}/suggestions**`, (route) =>
    route.fulfill(json({ suggestions: values.suggestions?.() ?? [], nextCursor: null })),
  );
  await page.route(`**/api/artifacts/${id}/authors**`, (route) =>
    route.fulfill(json(values.authors?.() ?? { version: 1, draft: false, authors: [], blocks: {} })),
  );
  const record = (path: string, body: unknown, answer: unknown) => {
    posted[path] = [...(posted[path] ?? []), body];
    return json(answer);
  };
  await page.route(`**/api/artifacts/${id}/doc/checkpoint`, (route) =>
    route.fulfill(
      record("checkpoint", route.request().postDataJSON(), { version: 2, created: true, kind: "saved" }),
    ),
  );
  await page.route(`**/api/suggestions/*/*`, (route) => {
    const verb = route.request().url().split("/").pop() ?? "";
    return route.fulfill(
      record(`suggestion:${verb}`, route.request().postDataJSON(), { status: `${verb}ed`, seq: 3 }),
    );
  });
  await page.route(`**/api/runs/*/*`, (route) => {
    const verb = route.request().url().split("/").pop() ?? "";
    return route.fulfill(
      record(`run:${verb}`, {}, { ...run, status: verb === "accept" ? "accepted" : "rejected", version: 2 }),
    );
  });
  await page.route(`**/api/artifacts/${id}/doc/runs`, (route) =>
    route.fulfill(record("runs", route.request().postDataJSON(), { ...run, status: "active" })),
  );
  return posted;
}

const run: Run = {
  id: "00000000-0000-4000-8000-0000000000aa",
  status: "finished",
  edits: "suggestion",
  goal: "Fold the Q3 board notes into Plans, and cite them.",
  agent: "Claude Code",
  startedBy: "Zahin",
  startedAt: now,
  expiresAt: later,
  finishedAt: now,
  version: null,
  suggestions: 1,
};

const editor = (page: Page) => page.getByRole("textbox", { name: "Edit Pricing" });
/** The editor takes typing only once the server's copy of the page has arrived. */
async function ready(page: Page) {
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText("Connecting to the page…")).toHaveCount(0, { timeout: 15_000 });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
}
// The browser runs on this machine: ⌘ moves by document on a Mac, Ctrl+End does on Linux and Windows.
const MAC = process.platform === "darwin";
const DOC_END = MAC ? "Meta+ArrowDown" : "Control+End";
const LINE_SELECT_BACK = MAC ? "Shift+Meta+ArrowLeft" : "Shift+Home";
/** A new paragraph after the page's last one. */
async function typeAtEnd(page: Page, text: string) {
  await editor(page).locator("p").last().click();
  // The document's end, not the visual line's: a wrapped paragraph would be split.
  await page.keyboard.press(DOC_END);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

test("Edit loads the editor chunk on tap; typing, modes, a suggestion accepted, Save version", async ({
  page,
}, info) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ colorScheme: "light" });
  const wiki = `edit-${info.project.name}-${info.repeatEachIndex}`;
  const id = await seedPage(page, wiki);
  let open: Suggestion[] = [];
  const posted = await mockEditing(page, id, { doc: () => docState(), suggestions: () => open });
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/editor-[^/]+\.js$/.test(request.url())) chunks.push(request.url());
  });

  await page.goto(`/${wiki}/pricing`);
  await expect(page.locator(".article h1")).toHaveText("Pricing");
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await expect(edit).toBeVisible();
  // Reading never loads the editor.
  expect(chunks).toEqual([]);
  const key = await edit.boundingBox();
  expect(key?.height).toBeGreaterThanOrEqual(44);
  await shot(page, "17-1-read-edit-key", { desktop: true });

  await edit.click();
  await ready(page);
  expect(chunks).toHaveLength(1);
  // The page arrived from the server, with no stray empty paragraph before it.
  await expect(editor(page).locator(":scope > *").first()).toHaveText("Pricing");
  await expect(editor(page).locator(":scope > *").nth(1)).toContainText("We charge per seat");
  await typeAtEnd(page, "Guests review for free.");
  await expect(editor(page)).toContainText("Guests review for free.");
  if (info.project.name === "desktop") {
    // ⌘K links the selection; an address that isn't http(s), mailto or a path is refused.
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press(LINE_SELECT_BACK);
    await page.keyboard.press("ControlOrMeta+k");
    const sheet = page.getByRole("dialog", { name: "Link" });
    await expect(sheet).toBeVisible();
    const address = sheet.getByRole("textbox", { name: "Address" });
    await expect(address).toBeFocused();
    await address.fill("javascript:alert(1)");
    await address.press("Enter");
    await expect(
      page.getByText("Use a web address (https://), an email (mailto:) or a page path."),
    ).toBeVisible();
    await address.fill("https://example.com/guests");
    await address.press("Enter");
    await expect(editor(page).locator('a[href="https://example.com/guests"]')).toHaveText(
      "Guests review for free.",
    );
    // A pasted link keeps its words and loses an unsafe address.
    await editor(page).locator("p").last().click();
    await page.keyboard.press(DOC_END);
    await editor(page).evaluate((dom) => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        '<p><a href="javascript:alert(1)">bad link</a> and <a href="/ok">good link</a></p>',
      );
      data.setData("text/plain", "bad link and good link");
      dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(editor(page)).toContainText("bad link and good link");
    await expect(editor(page).locator("a", { hasText: "bad link" })).toHaveCount(0);
    await expect(editor(page).locator('a[href="/ok"]')).toHaveText("good link");
  }
  for (const word of ["Write", "Pair", "Delegate"])
    await expect(page.getByRole("button", { name: word, exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Write", exact: true }).first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Every key of the toolbar is a thumb's width.
  for (const button of await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button").all()) {
    const size = await button.boundingBox();
    if (size)
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(
        info.project.name === "desktop" ? 40 : 44,
      );
  }
  expect(await overflowsSideways(page)).toBe(false);
  await shot(page, "17-2-editor-write", { desktop: true });

  // Pair: the agent's edit arrives inline as a suggestion on the block, old words struck.
  // The paragraph with the price, as the draft holds it (from the server when the socket is up).
  const plans = editor(page).locator("p").filter({ hasText: "Team is $12" }).first();
  const block = await plans.getAttribute("data-block");
  expect(block).toMatch(/^~[0-9a-z]{10}$/);
  const before = (await plans.textContent()) ?? "";
  const after = before.replace("$12", "$14");
  open = [suggestion({ block: block as string, markdown: after, html: `<p>${after}</p>` })];
  await page.getByRole("button", { name: "Pair", exact: true }).first().click();
  const card = page.getByRole("group", { name: "Claude suggests" });
  await expect(card).toBeVisible();
  await expect(card.locator("del.s")).toHaveText("12");
  await expect(card.locator("ins.s")).toHaveText("14");
  const [reject, accept] = [
    card.getByRole("button", { name: "Reject" }),
    card.getByRole("button", { name: "Accept" }),
  ];
  const r = await reject.boundingBox();
  const a = await accept.boundingBox();
  expect(r && a && a.x - (r.x + r.width)).toBeCloseTo(12, 0);
  expect(r?.height).toBeGreaterThanOrEqual(44);
  await shot(page, "17-3-pair-suggestion", { desktop: true });
  open = [];
  await accept.click();
  await expect(card).toHaveCount(0);
  expect(posted["suggestion:accept"]).toHaveLength(1);

  // Save version, from the keyboard on a desktop and the menu on a phone.
  if (info.project.name === "desktop") await page.keyboard.press("ControlOrMeta+s");
  else {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: /Save version/ }).click();
  }
  await page.getByRole("textbox", { name: "Name this version" }).fill("Q3 pricing folded in");
  await shot(page, "17-4-save-version");
  await page.getByRole("button", { name: "Save v2" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved v2" })).toBeVisible();
  expect(posted.checkpoint).toEqual([{ name: "Q3 pricing folded in" }]);

  // Esc leaves the editor, back to the page.
  await editor(page).press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator(".article h1")).toHaveText("Pricing");
  expect(errors.filter((e) => !/WebSocket|doc\/sync/.test(e))).toEqual([]);
});

test("Delegate: ask, then review the run's changes and keep them", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const wiki = `delegate-${info.project.name}-${info.repeatEachIndex}`;
  const id = await seedPage(page, wiki);
  let runs: Run[] = [];
  let list: Suggestion[] = [];
  const posted = await mockEditing(page, id, { doc: () => docState({ runs }), suggestions: () => list });
  // Through the wiki's /slug to /slug/doc redirect, which keeps ?edit=1.
  await page.goto(`/${wiki}/pricing?edit=1`);
  await expect(page).toHaveURL(new RegExp(`/${wiki}/pricing/doc\\?edit=1$`));
  await ready(page);
  await typeAtEnd(page, "Monthly billing stays.");
  await page.getByRole("button", { name: "Delegate", exact: true }).first().click();
  const goal = page.getByRole("textbox", { name: "What should the agent do" });
  await goal.fill(run.goal);
  await shot(page, "17-5-delegate-ask");
  await page.getByRole("button", { name: "Start" }).click();
  expect(posted.runs).toEqual([{ goal: run.goal }]);

  // The run finished with one change; the review shows it with its source.
  const block = await editor(page)
    .locator("p")
    .filter({ hasText: "Annual billing" })
    .first()
    .getAttribute("data-block");
  runs = [run];
  list = [
    suggestion({
      run: run.id,
      block: block as string,
      markdown: "Annual billing takes two and a half months off.",
      html: "<p>Annual billing takes two and a half months off.</p>",
    }),
  ];
  await page.reload();
  await expect(page.getByText("Claude finished")).toBeVisible();
  await page.getByRole("button", { name: "Review the changes" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("From notes")).toBeVisible();
  await expect(sheet.locator(".review-diff")).toContainText("two and a half months off.");
  await shot(page, "17-6-delegate-review", { desktop: true });
  await sheet.getByRole("button", { name: "Keep" }).click();
  expect(posted["run:accept"]).toHaveLength(1);
});

test("the blue pencil and who wrote a passage, in the reader", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const wiki = `pencil-${info.project.name}-${info.repeatEachIndex}`;
  const id = await seedPage(page, wiki);
  const detail = await (await page.request.get(`/api/artifacts/${id}/versions/1`)).json();
  const html = await (
    await page.request.get(`/api/artifacts/${id}/v/1/article/${detail.pages[0].key}`)
  ).text();
  const plans = { key: /data-block="([^"]+)"[^>]*>Free covers/.exec(html)?.[1] };
  expect(plans.key).toBeTruthy();
  await mockEditing(page, id, {
    doc: () => docState(),
    authors: () => ({
      version: 1,
      draft: false,
      authors: [AGENT, { key: "a1", kind: "person", name: "Zahin", agent: null, for: null, sources: [] }],
      blocks: {
        [plans?.key ?? ""]: [
          { s: 0, e: 42, a: "a2", t: now },
          { s: 42, e: 70, a: "a1", t: now },
        ],
      },
    }),
  });
  await page.route(`**/api/artifacts/${id}/links`, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...real,
        sources: [{ project: wiki, slug: "notes", title: "Q3 board notes", untrusted: true }],
      },
    });
  });
  await page.goto(`/${wiki}/pricing`);
  const pen = page.locator(".article span.pen").first();
  await expect(pen).toHaveText("Free covers one person and three projects.");
  await pen.click();
  await expect(page.getByText("Claude wrote this")).toBeVisible();
  await expect(page.getByText(/For Maya/)).toBeVisible();
  await expect(page.getByText("Untrusted source", { exact: true }).last()).toBeVisible();
  await shot(page, "17-7-who-wrote-this", { desktop: true });
});

test("without edit access: no Edit key, Comment and Ask to edit instead", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  const wiki = `readonly-${info.project.name}-${info.repeatEachIndex}`;
  const id = await seedPage(page, wiki);
  await mockEditing(page, id, { doc: () => docState({ canEdit: false, canAccept: false, agents: null }) });
  await page.goto(`/${wiki}/pricing`);
  await expect(page.locator(".article h1")).toHaveText("Pricing");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Ask to edit" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("You can read and comment")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Comment" })).toBeVisible();
  await shot(page, "17-8-no-edit-access", { desktop: true });
  await sheet.getByRole("button", { name: "Ask to edit" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // A page the browser can't edit says why, in the same place.
  await page.route(`**/api/artifacts/${id}/doc`, (route) =>
    route.fulfill({ json: docState({ editable: false, reason: "has_backend" }) }),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Not editable here" }).click();
  await expect(page.getByText("This page has a backend, so it's changed with the CLI.")).toBeVisible();
  await shot(page, "17-9-not-editable");
});

test("a second writer types at the same time, and nothing is lost", async ({ page, browser }, info) => {
  // Needs the live socket (worker 2's provider and the server's sync route), not the mocks above.
  test.skip(!existsSync("src/editing/provider.ts"), "the sync provider hasn't landed in this checkout");
  const wiki = `two-${info.project.name}-${info.repeatEachIndex}`;
  await seedPage(page, wiki);
  const other = await browser.newContext({ storageState: "e2e/.auth.json", serviceWorkers: "block" });
  const second = await other.newPage();
  await page.goto(`/${wiki}/pricing/doc?edit=1`);
  await second.goto(`/${wiki}/pricing/doc?edit=1`);
  await ready(page);
  await ready(second);
  await editor(page).locator("p").first().click();
  await editor(second).locator("p").last().click();
  // Typing mid-word: when a typed character equals the next one, y-prosemirror's character diff marks the
  // existing character as the typist's, and the server refuses that as a change of author (reported to
  // the lead, apps/server/src/realtime/sync.ts). This test fails until that is settled.
  await Promise.all([page.keyboard.type(" One."), second.keyboard.type(" Two.")]);
  for (const view of [page, second]) {
    await expect(editor(view)).toContainText("One.");
    await expect(editor(view)).toContainText("Two.");
  }
  await other.close();
});

test("signing out forgets the drafts this device kept", async ({ browser }) => {
  // Its own session: signing out ends the session it signed in with, not the one the other tests share.
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await signIn(page);
  await expect(page).not.toHaveURL(/sign-in/);
  const unsent = (write: boolean) =>
    page.evaluate(
      (write) =>
        new Promise<string[]>((resolve, reject) => {
          const open = indexedDB.open("artifacts-edit", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("unsent");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const store = db.transaction("unsent", "readwrite").objectStore("unsent");
            if (write) store.put([new Uint8Array([1, 2, 3])], "edit:00000000-0000-4000-8000-000000000001:1");
            const keys = store.getAllKeys();
            keys.onsuccess = () => {
              db.close();
              resolve(keys.result as string[]);
            };
          };
        }),
      write,
    );
  expect(await unsent(true)).toHaveLength(1);
  await page.evaluate(() => localStorage.setItem("artifacts.edit.x.author", "a1"));
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/sign-in/);
  expect(await unsent(false)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("artifacts.edit.x.author"))).toBeNull();
  await context.close();
});

test("Ctrl+K is Link in the editor, as on Linux and Windows, and Search stays shut", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "A keyboard shortcut");
  // ProseMirror reads the platform once, when it loads: as on Linux, Mod is Ctrl, whatever this machine is.
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }),
  );
  const wiki = `edit-ctrl-${info.repeatEachIndex}`;
  const id = await seedPage(page, wiki);
  await mockEditing(page, id, { doc: () => docState(), suggestions: () => [] });
  await page.goto(`/${wiki}/pricing`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await ready(page);
  await editor(page).locator("p").last().click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Link" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Out of the editor, the same chord is still Search.
  await page.keyboard.press("Escape");
  await page.locator(".article h1").click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
});
