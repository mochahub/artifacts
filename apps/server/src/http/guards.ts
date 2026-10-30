import type { MiddlewareHandler } from "hono";
import type { Deps } from "../api/deps.ts";
import type { ApiVars } from "../api/routes.ts";
import { resolveCaller } from "../auth/resolve.ts";
import { GUEST_COOKIE, SESSION_COOKIE } from "../auth/sessions.ts";
import { findOrg, type OrgRow } from "../db/index.ts";
import { MIN_CLI_VERSION } from "../version.ts";
import { ApiError } from "./errors.ts";

const SETUP_ROUTES = new Set(["/api/health", "/api/meta", "/api/setup"]);

const newerThan = (a: string, b: string) => {
  const parts = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

/**
 * Runs before every /api route: setup mode (04), the CLI's minimum version, CSRF, then the caller.
 * The org row is cached once it exists; it's only ever created once, and its name is re-read per route when needed.
 */
export function apiGuards(deps: Deps): MiddlewareHandler<ApiVars> {
  let cached: OrgRow | null = null;
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith("/api/")) return next();

    const cli = c.req.header("artifacts-cli");
    if (cli && newerThan(MIN_CLI_VERSION, cli)) {
      throw new ApiError("cli_outdated", "This CLI is too old. Run artifacts upgrade.", {
        minVersion: MIN_CLI_VERSION,
      });
    }

    cached ??= await findOrg(deps.db);
    if (!cached) {
      if (!SETUP_ROUTES.has(path)) throw new ApiError("setup_mode", "This deployment isn't set up yet.");
      return next();
    }
    if (path === "/api/health" || path === "/api/meta") return next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !c.req.header("authorization")) {
      const origin = c.req.header("origin");
      const cookies = c.req.header("cookie") ?? "";
      const hasCookie = cookies.includes(`${SESSION_COOKIE}=`) || cookies.includes(`${GUEST_COOKIE}=`);
      // A cookie needs a good Origin. So does anything a browser sends, which stops forged sign-ins too.
      if ((hasCookie && !origin) || (origin && !(await deps.origins()).includes(origin))) {
        throw new ApiError("csrf", "This request came from another site.");
      }
    }

    c.set("org", cached);
    c.set("caller", await resolveCaller(c, deps, cached));
    return next();
  };
}
