import { expect, test } from "@playwright/test";
import { auth, overflowsSideways, shot, watchErrors } from "./helpers.ts";

test("wiki home, direct reading, sources, backlinks and audience labels", async ({ page, request }, info) => {
  const wiki = `brain-${info.project.name}-${info.repeatEachIndex}`;
  const onlyMe = `only-me-${info.project.name}-${info.repeatEachIndex}`;
  const errors = watchErrors(page);
  await page.emulateMedia({ colorScheme: "light" });
  for (const [slug, name, privateWiki] of [
    [wiki, "Company brain", false],
    [onlyMe, "My notebook", true],
  ] as const) {
    const response = await request.post("/api/wikis", {
      headers: auth(),
      data: { slug, name, onlyMe: privateWiki },
    });
    expect(response.ok()).toBe(true);
  }
  const publish = async (slug: string, title: string, markdown: string, meta = {}) => {
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
            slug,
            title,
            summary: `${title} for the wiki.`,
            markdown,
            ...meta,
          },
        },
      },
    });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.error, JSON.stringify(result)).toBeUndefined();
    expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
  };
  await publish("rules", "Wiki rules", "# Wiki rules\n\nCite sources and connect related pages.");
  await publish("team-notes", "Team notes", "# Team notes\n\nOur team's agreed working practices.", {
    role: "source",
  });
  await publish("web-clip", "Web research", "# Web research\n\nAn external perspective to verify.", {
    role: "source",
    untrusted: true,
    origin: "https://example.com/research",
  });
  await publish(
    "working-together",
    "Working together",
    "# Working together\n\nWe make decisions in writing and review them as a team.\n\nSee [[Decisions]] and [[Future plans]].\n\n## Practice\n\nKeep the evidence close to each decision. External research is a starting point; check it against our experience.",
    { sources: ["web-clip", "team-notes"] },
  );
  await publish("decisions", "Decisions", "# Decisions\n\nSee [[Working together]] for our approach.", {
    sources: ["team-notes"],
  });
  await publish("orphan", "Independent note", "# Independent note\n\nRelated reading: [[Decisions]].");

  await page.goto(`/${wiki}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Company brain");
  const section = (name: string) =>
    page.locator("section.wiki-section").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(section("Rules").getByRole("link", { name: /Wiki rules/ })).toBeVisible();
  await expect(section("Pages").locator("a.li")).toHaveCount(3);
  await expect(section("Sources").locator("a.li")).toHaveCount(2);
  await expect(section("Sources").getByText("Untrusted", { exact: true })).toBeVisible();
  await expect(section("Sources").getByText("example.com", { exact: true })).toBeVisible();
  const attention = section("Needs attention");
  for (const label of ["Not written yet", "No links here", "Untrusted sources"]) {
    await expect(attention.getByRole("heading", { name: label, exact: true })).toBeVisible();
  }
  await expect(attention.getByText("future-plans", { exact: true })).toBeVisible();
  await expect(
    attention
      .locator("div")
      .filter({ has: page.getByRole("heading", { name: "No links here", exact: true }) })
      .last()
      .getByRole("link", { name: "Independent note", exact: true }),
  ).toBeVisible();
  await expect(
    section("Recent changes").getByRole("link", { name: "Working together", exact: true }),
  ).toBeVisible();
  expect(await overflowsSideways(page)).toBe(false);
  await shot(page, "16-1-wiki-home");

  await page.goto(`/${wiki}/working-together`);
  await expect(page).toHaveURL(new RegExp(`/${wiki}/working-together/doc$`));
  await expect(page.locator(".article h1")).toHaveText("Working together");
  await expect(page.getByText("Written from untrusted sources", { exact: true })).toBeVisible();
  const wanted = page.locator(".article a.wanted");
  await expect(wanted).toHaveText("Future plans");
  await expect(wanted).toHaveAttribute("href", `/${wiki}/future-plans`);
  await expect(wanted).toHaveAttribute("title", "Not written yet");
  await shot(page, "16-2-wiki-page");
  const footer = page.locator(".wiki-footer");
  await expect(footer.getByRole("heading", { name: "Sources", exact: true })).toBeVisible();
  await expect(footer.getByRole("heading", { name: "Linked from", exact: true })).toBeVisible();
  await expect(footer.getByRole("link", { name: /Web research/ })).toBeVisible();
  await expect(footer.getByText("Untrusted source, example.com", { exact: true })).toBeVisible();
  await expect(footer.getByRole("link", { name: /Decisions/ })).toBeVisible();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(footer.getByRole("link", { name: /Decisions/ })).toBeInViewport();
  expect(await overflowsSideways(page)).toBe(false);
  await shot(page, "16-3-wiki-footer");
  await page.goto("/projects");
  await expect(page.locator(`a.li[href="/${onlyMe}"]`)).toContainText("Only you");
  expect(errors).toEqual([]);
});

test("long unbroken audience labels wrap on wiki home and project rows at 375px", async ({
  page,
  request,
}, info) => {
  const slug = `wrap-${info.project.name}`;
  await request.post("/api/wikis", { headers: auth(), data: { slug, name: "Wrapping" } });
  const label = "Audience".repeat(50);
  await page.route("**/api/wikis/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.project.audience.label = label;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/projects*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const project of body) if (project.slug === slug) project.audience.label = label;
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of [`/${slug}`, "/projects"]) {
    await page.goto(path);
    await expect(page.getByText(label, { exact: path !== "/projects" })).toBeVisible();
    expect(await overflowsSideways(page)).toBe(false);
  }
});
