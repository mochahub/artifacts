import type { Context } from "hono";
import type { Deps } from "../api/deps.ts";
import { findOrg } from "../db/index.ts";
import { ApiError } from "./errors.ts";

/** Related Origin Requests (SPEC §7.3): served only by the home domain, never listing the content host. */
export const wellKnownWebauthn = (deps: Deps) => async (c: Context) => {
  const org = await findOrg(deps.db);
  const host = (c.req.header("host") ?? "").split(":")[0]?.toLowerCase();
  if (!org || host !== org.homeDomain) throw new ApiError("not_found", "Not found.");
  const origins = (await deps.origins()).filter(
    (origin) => new URL(origin).hostname !== org.homeDomain && origin !== deps.env.contentUrl,
  );
  return c.json({ origins });
};
