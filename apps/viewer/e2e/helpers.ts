import { readFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { SECRET } from "./stack.ts";

export const OWNER = { name: "Zahin", email: "zahin@example.com", password: "correct horse battery" };
export const SETUP_TOKEN = SECRET;

/** Fails on anything the browser refused, such as a CSP violation from the server's headers. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    // A 401 from /api/me is how the viewer learns nobody is signed in; WebKit logs it as an error.
    if (message.type() === "error" && !message.text().includes("401")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The element's box, for layout checks: where it is on screen, and that it is on screen. */
export const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    });

/** True when the document can be scrolled sideways: something is wider than the screen. */
export const overflowsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

export async function signIn(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The owner's API token, which claim.setup.ts left for the rest of the run. */
export const token = () => readFileSync("e2e/.token", "utf8").trim();
export const auth = () => ({ Authorization: `Bearer ${token()}` });

/**
 * A screenshot for docs/mocks/shots, from the phone run; `desktop` adds the desktop run's as desktop-<name>.
 * The other runs take none, so two never write one file.
 */
export async function shot(page: Page, name: string, { desktop = false } = {}) {
  const { project } = test.info();
  const file = project.use.isMobile ? name : desktop && project.name === "desktop" ? `desktop-${name}` : null;
  if (file) await page.screenshot({ animations: "disabled", path: `../../docs/mocks/shots/${file}.png` });
}

/** Someone with no session, on the same device as the test. */
export const stranger = (browser: Browser) =>
  browser.newContext({ storageState: { cookies: [], origins: [] } });

/** Makes an invite from People as the owner, and returns its link. */
export async function invite(page: Page, email: string, role?: "Reviewer" | "Member") {
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByLabel("Email").fill(email);
  if (role) await page.getByRole("button", { name: role, exact: true }).click();
  await page.getByRole("button", { name: "Copy invite link" }).click();
  return (await page.getByRole("dialog").getByText("/join/").textContent()) as string;
}

/** Invites someone and signs them in with a password, in a browser of their own. */
export async function join(page: Page, browser: Browser, email: string, name: string) {
  const url = await invite(page, email);
  const context = await stranger(browser);
  const other = await context.newPage();
  await other.goto(url);
  await other.getByLabel("Your name").fill(name);
  await other.getByRole("button", { name: "Use a password instead" }).click();
  await other.getByLabel("Password").fill("a perfectly long password");
  await other.getByRole("button", { name: "Join" }).click();
  await expect(other.getByRole("heading", { level: 1 })).toHaveText("Review");
  return { context, page: other };
}

/** The canvas's page capsule, which names the frame or page on screen and then where it sits. */
export const here = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${title} `) });

/** The canvas transform, which the engine mirrors onto the world as numbers. */
export const transform = (page: Page) =>
  page.locator(".world").evaluate((world: HTMLElement) => {
    const { x, y, s } = world.dataset;
    return { x: Number(x), y: Number(y), s: Number(s) };
  });

/** Waits until the canvas has stopped moving: its transform the same for a run of frames. */
export const settle = (page: Page) =>
  page.locator(".world").evaluate(
    (world: HTMLElement) =>
      new Promise<void>((done) => {
        let last = "";
        let still = 0;
        const look = () => {
          const now = `${world.dataset.x} ${world.dataset.y} ${world.dataset.s}`;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 10) done();
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );

/** A pointer event on the canvas; `id` 2 is a second finger. */
export const pointer = (page: Page, type: string, x: number, y: number, { id = 1, touch = false } = {}) =>
  page.locator(".cv").dispatchEvent(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    bubbles: true,
    isPrimary: id === 1,
    ...(touch ? { pointerType: "touch" } : {}),
  });

/** A tap on the canvas at a point on screen. */
export async function tap(page: Page, x: number, y: number) {
  await pointer(page, "pointerdown", x, y);
  await pointer(page, "pointerup", x, y);
}
