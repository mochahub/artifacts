import type { Context, Handler } from "hono";
import type { z } from "zod";
import type { Caller } from "../auth/caller.ts";
import { type Action, can, type Resource } from "../auth/can.ts";
import type { OrgRow } from "../db/index.ts";
import type { createApp } from "../http/app.ts";
import { ApiError } from "../http/errors.ts";

export type ApiVars = { Variables: { requestId: string; caller: Caller; org: OrgRow } };
export type ApiContext = Context<ApiVars>;

/** Either a route is public (the test in routes.test.ts holds the allowlist), or it names an action. */
export type Guard =
  | { public: true }
  | {
      action: Action;
      /** The artifact the action applies to. Without one the action is about the organization. */
      resource?: (c: ApiContext) => Promise<Resource>;
      /** Needs a sign-in within the last 10 minutes (04). */
      recentAuth?: boolean;
    };

export type RouteInfo = { method: string; path: string; guard: Guard };

/** The answer for a denied call: never say that something exists to someone who can't see it. */
function denial(caller: Caller, action: Action, resource: Resource): ApiError {
  if (caller.kind === "anonymous") return new ApiError("unauthenticated", "Sign in first.");
  if (resource.type === "artifact") {
    if (resource.archivedAt && can(caller, action, { ...resource, archivedAt: null })) {
      return new ApiError("read_only", "This artifact is archived, so it's read-only.");
    }
    if (!can(caller, "artifact.read", resource)) return new ApiError("not_found", "Not found.");
  }
  return new ApiError("forbidden", "You can't do that.");
}

export function requireCan(c: ApiContext, action: Action, resource: Resource) {
  const caller = c.get("caller");
  if (!can(caller, action, resource)) throw denial(caller, action, resource);
}

/** Registers routes, so every one is listed with its guard and none can skip the check. */
export class Routes {
  readonly list: RouteInfo[] = [];

  constructor(private readonly app: ReturnType<typeof createApp>) {}

  private add(
    method: "get" | "post" | "patch" | "delete" | "put",
    path: string,
    guard: Guard,
    handler: Handler<ApiVars>,
  ) {
    this.list.push({ method: method.toUpperCase(), path, guard });
    const guarded: Handler<ApiVars> = async (c, next) => {
      if ("action" in guard) {
        const resource: Resource = guard.resource ? await guard.resource(c) : { type: "org" };
        const caller = c.get("caller");
        if (guard.recentAuth && caller.kind === "person" && !caller.recentAuth) {
          if (can({ ...caller, recentAuth: true }, guard.action, resource)) {
            throw new ApiError("recent_auth_required", "Sign in again to do this.");
          }
        }
        requireCan(c, guard.action, resource);
      }
      return handler(c, next);
    };
    (this.app as unknown as Record<string, (path: string, handler: Handler<ApiVars>) => void>)[method]?.(
      path,
      guarded,
    );
  }

  get(path: string, guard: Guard, handler: Handler<ApiVars>) {
    this.add("get", path, guard, handler);
  }
  post(path: string, guard: Guard, handler: Handler<ApiVars>) {
    this.add("post", path, guard, handler);
  }
  put(path: string, guard: Guard, handler: Handler<ApiVars>) {
    this.add("put", path, guard, handler);
  }
  patch(path: string, guard: Guard, handler: Handler<ApiVars>) {
    this.add("patch", path, guard, handler);
  }
  delete(path: string, guard: Guard, handler: Handler<ApiVars>) {
    this.add("delete", path, guard, handler);
  }
}

/** Parses a JSON body with the schema from packages/schema (01). */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("invalid", "The body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("invalid", "The request isn't valid.", { issues: parsed.error.issues });
  }
  return parsed.data;
}
