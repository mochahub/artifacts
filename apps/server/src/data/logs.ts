import { HOUR_MS } from "@artifacts/schema";
import { lt } from "drizzle-orm";
import { backendLogs } from "../db/schema.ts";
import type { Deps } from "../deps.ts";

/** 02, `backend_logs`: a job deletes rows older than 24 hours. */
const KEEP_MS = 24 * HOUR_MS;

export const expireLogs = (deps: Pick<Deps, "db" | "clock">) =>
  deps.db
    .delete(backendLogs)
    .where(lt(backendLogs.createdAt, new Date(deps.clock.now().getTime() - KEEP_MS)));
