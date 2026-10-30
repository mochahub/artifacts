import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers.ts";

/**
 * 01: every route is registered with an action, or sits on this list of public routes. Adding a
 * public route means adding it here, on purpose.
 */
const PUBLIC_ROUTES = [
  "POST /api/setup",
  "POST /api/recover",
  "POST /api/auth/password",
  "GET /api/reset/:token",
  "POST /api/reset/:token",
  "POST /api/device/start",
  "POST /api/device/poll",
].sort();

describe("the route list", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(() => t.stop());

  test("public routes are exactly the allowlist", () => {
    const open = t.server.routes
      .filter((route) => "public" in route.guard)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(open).toEqual(PUBLIC_ROUTES);
  });

  test("every other route names an action", () => {
    for (const route of t.server.routes) {
      if (!("public" in route.guard)) expect(route.guard.action).toBeString();
    }
  });
});
