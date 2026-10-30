import type { Page } from "@playwright/test";

export const OWNER = { name: "Zahin", email: "zahin@example.com", password: "correct horse battery" };
export const SETUP_TOKEN = "e2e-secret-e2e-secret-e2e-secret-e2e";

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

export async function signIn(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
