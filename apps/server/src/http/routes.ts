import type { Context, Handler } from "hono";
import type { Caller } from "../auth/caller.ts";
import { type Action, type CallerFor, can, canAfterReauth, type Resource, seesProject } from "../auth/can.ts";
import type { OrgRow } from "../db/index.ts";
import type { createApp } from "./app.ts";
import { ApiError } from "./errors.ts";

export type ApiVars = { Variables: { requestId: string; caller: Caller; org: OrgRow } };
export type ApiContext = Context<ApiVars>;

const ORG: Resource = { type: "org" };
type OrgResource = typeof ORG;
type SignedIn = Exclude<Caller, { kind: "anonymous" }>;

/** What a handler sees: the caller as the guard narrowed it, and the resource the guard checked. */
export type RouteContext<C extends Caller = Caller, R = OrgResource> = Context<{
  Variables: { requestId: string; org: OrgRow; caller: C; resource: R };
}>;
type RouteHandler<C extends Caller, R> = (c: RouteContext<C, R>) => Response | Promise<Response>;
export type Loader<R extends Resource> = (c: ApiContext) => Promise<R>;

/** What a helper reads from a request: its params and headers, and what the guard left in `var`. */
export type RouteRequest<C extends Caller = Caller, R = never> = Pick<ApiContext, "req"> & {
  var: { readonly org: OrgRow; readonly caller: C } & ([R] extends [never]
    ? unknown
    : { readonly resource: R });
};

type Checked<A extends Action, R extends Resource> = {
  action: A;
  /** The artifact, team or project it applies to. Without one the action is about the organization. */
  resource?: Loader<R>;
  /** Needs a sign-in within the last 10 minutes (04). */
  recentAuth?: boolean;
  /** The artifact's own page: a deleted one is 410 for those who could see it (03, "Errors"). */
  page?: boolean;
  /** Changes the artifact, so an archived one answers read_only (03, "Lifecycle"). */
  writes?: boolean;
};

/** Either a route is public (the test in routes.test.ts holds the allowlist), or it names an action. */
export type Guard =
  | { public: true }
  /** The check depends on the body, so the handler calls requireCan itself. */
  | { action: Action; inHandler: true }
  | Checked<Action, Resource>;

export type RouteInfo = { method: string; path: string; guard: Guard };

type Register = {
  (path: string, guard: { public: true }, handler: (c: ApiContext) => Response | Promise<Response>): void;
  (
    path: string,
    guard: { action: Action; inHandler: true },
    handler: RouteHandler<SignedIn, undefined>,
  ): void;
  <A extends Action, R extends Resource = OrgResource>(
    path: string,
    guard: Checked<A, R>,
    handler: RouteHandler<CallerFor<A>, R>,
  ): void;
};

const notFound = () => new ApiError("not_found", "Not found.");
const readOnly = () => new ApiError("read_only", "This artifact is archived, so it's read-only.");

/** The answer for a denied call: never say that something exists to someone who can't see it. */
function denial(caller: Caller, action: Action, resource: Resource, page = false): ApiError {
  if (caller.kind === "anonymous") return new ApiError("unauthenticated", "Sign in first.");
  if (resource.type === "artifact") {
    if (page && resource.deletedAt) {
      // Only someone who could see it learns that it was deleted; everyone else, that it never was (04).
      if (!can(caller, "artifact.read", { ...resource, deletedAt: null, deletedBy: null })) return notFound();
      return new ApiError("gone", "This artifact was deleted.", {
        deletedAt: resource.deletedAt.toISOString(),
      });
    }
    if (resource.archivedAt && can(caller, action, { ...resource, archivedAt: null })) return readOnly();
    if (!can(caller, "artifact.read", resource)) return notFound();
  }
  if (resource.type === "team" && !can(caller, "team.read", ORG)) return notFound();
  if (resource.type === "project" && !seesProject(caller, resource)) return notFound();
  return new ApiError("forbidden", "You can't do that.");
}

/** For checks that depend on the body. Passing it proves the caller is one this action can allow. */
export function requireCan<A extends Action>(
  caller: Caller,
  action: A,
  resource: Resource,
): asserts caller is CallerFor<A> {
  if (!can(caller, action, resource)) throw denial(caller, action, resource);
}

/** Registers routes, so every one is listed with its guard and none can skip the check. */
export class Routes {
  readonly list: RouteInfo[] = [];

  constructor(private readonly app: ReturnType<typeof createApp>) {}

  private add(
    method: string,
    path: string,
    guard: Guard,
    handler: (c: never) => Response | Promise<Response>,
  ) {
    this.list.push({ method, path, guard });
    const guarded: Handler<ApiVars> = async (c) => {
      if ("action" in guard) {
        const caller = c.get("caller");
        // Before the resource: an unknown id and a real one must look the same to nobody (03).
        if (caller.kind === "anonymous") throw new ApiError("unauthenticated", "Sign in first.");
        if (!("inHandler" in guard)) {
          const resource = guard.resource ? await guard.resource(c) : ORG;
          if (guard.recentAuth && caller.kind === "person" && !caller.recentAuth) {
            if (canAfterReauth(caller, guard.action, resource)) {
              throw new ApiError("recent_auth_required", "Sign in again to do this.");
            }
          }
          if (!can(caller, guard.action, resource)) throw denial(caller, guard.action, resource, guard.page);
          if (guard.writes && resource.type === "artifact" && resource.archivedAt) throw readOnly();
          (c as unknown as RouteContext<Caller, Resource>).set("resource", resource);
        }
      }
      return handler(c as never);
    };
    (this.app as unknown as { on(method: string, path: string, handler: Handler<ApiVars>): void }).on(
      method,
      path,
      guarded,
    );
  }

  private register(method: string): Register {
    return (path: string, guard: Guard, handler: (c: never) => Response | Promise<Response>) =>
      this.add(method, path, guard, handler);
  }

  readonly get = this.register("GET");
  readonly post = this.register("POST");
  readonly put = this.register("PUT");
  readonly patch = this.register("PATCH");
  readonly delete = this.register("DELETE");
}
