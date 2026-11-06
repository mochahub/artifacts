import { type DataOp, preflight, runBackend as runInSandbox } from "@artifacts/sandbox";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { findArtifact } from "../auth/access.ts";
import type { Caller } from "../auth/caller.ts";
import { callerKey } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import { checkKey, deleteValue, listKeys, pseudonym, putValue } from "../data/store.ts";
import { findOrg } from "../db/index.ts";
import { backendLogs, versions } from "../db/schema.ts";
import type { Deps } from "../deps.ts";
import { readLimited } from "../http/body.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey, dataPrefix } from "../layout.ts";
import { knownBlobs } from "../publish/blobs.ts";
import { PreconditionFailed } from "../s3.ts";
import type { SandboxPool } from "../sandbox/pool.ts";
import type { ContentPayload } from "./token.ts";

const MINUTE = 60_000;
const LOG_BYTES_PER_MINUTE = 1024 * 1024;

export const corsPreflight = preflight;

/** `votes` means shared/votes; a backend may also name `shared/…`, `me/<id>/…` or `files/…` (08). */
const objectPath = (artifactId: string, key: string) => {
  const safe = checkKey(key);
  const scoped = /^(shared|me|files)\//.test(safe) ? safe : `shared/${safe}`;
  return {
    key: `${dataPrefix(artifactId)}${scoped}`,
    scope: scoped.split("/")[0] as "shared" | "me" | "files",
  };
};

/** Applies one env.DATA call. The scope is the app's, recorded for this request; the sandbox only asks. */
async function applyData(
  deps: Deps,
  scope: {
    orgId: string;
    artifactId: string;
    callerId: string;
    readOnly: boolean;
    limits: Awaited<ReturnType<typeof orgOf>>["settings"]["limits"];
  },
  op: DataOp,
) {
  if (op.op === "get") {
    const object = await deps.bucket.get(objectPath(scope.artifactId, op.key ?? "").key);
    if (!object) return { value: null };
    return { value: { value: JSON.parse(new TextDecoder().decode(object.body)), etag: object.etag } };
  }
  if (op.op === "list") {
    const prefix = op.prefix ?? "";
    const base = prefix ? objectPath(scope.artifactId, prefix).key : `${dataPrefix(scope.artifactId)}shared/`;
    const page = await listKeys(deps, base, op.cursor);
    return {
      value: { keys: page.keys.map((entry) => `${prefix}${entry.key}`), nextCursor: page.nextCursor },
    };
  }
  if (scope.readOnly) throw new ApiError("read_only", "This caller can only read.");
  deps.limits.hit(`data:${scope.artifactId}:${scope.callerId}`, scope.limits.writesPerSecond, 1000);
  const path = objectPath(scope.artifactId, op.key ?? "");
  if (op.op === "put") {
    const written = await putValue(deps, {
      orgId: scope.orgId,
      artifactId: scope.artifactId,
      scope: path.scope,
      objectKey: path.key,
      value: op.value,
      limits: scope.limits,
      ifMatch: op.ifMatch === "*" ? undefined : op.ifMatch,
      ifNoneMatch: op.ifMatch === "*",
    });
    if (path.scope === "shared") {
      void deps.events.emit(scope.artifactId, "data", { scope: "shared", key: op.key, etag: written.etag });
    }
    return { value: written };
  }
  await deleteValue(deps, {
    orgId: scope.orgId,
    artifactId: scope.artifactId,
    scope: path.scope,
    objectKey: path.key,
    ifMatch: op.ifMatch,
  });
  if (path.scope === "shared") {
    void deps.events.emit(scope.artifactId, "data", { scope: "shared", key: op.key, etag: null });
  }
  return { value: true };
}

const orgOf = async (deps: Deps) => {
  const org = await findOrg(deps.db);
  if (!org) throw new ApiError("not_found", "Not found.");
  return org;
};

/** Runs a version's backend (08, "Request flow"). The content port has already checked the token. */
export async function runBackend(
  c: Context,
  deps: Deps,
  pool: SandboxPool,
  payload: ContentPayload,
  caller: Caller,
  path: string,
) {
  const org = await orgOf(deps);
  const limits = org.settings.limits;
  const artifact = await findArtifact(deps, org.id, payload.a);
  if (!artifact) throw new ApiError("not_found", "Not found.");
  const [version] = await deps.db
    .select({ hash: versions.backendHash })
    .from(versions)
    .where(and(eq(versions.artifactId, payload.a), eq(versions.n, payload.v)))
    .limit(1);
  if (!version?.hash) throw new ApiError("not_found", "This version has no backend.");
  const hash = version.hash;

  const key = callerKey(caller) ?? "nobody";
  deps.limits.hit(`backend:${payload.a}:${key}`, limits.backendRequestsPerMinute, MINUTE);

  const body = Buffer.from(await readLimited(c.req.raw, limits.backendRequestBytes)).toString();

  // The size was proved at publish. Looking it up first keeps a limit lowered since then from loading a huge file.
  const size = (await knownBlobs(deps, org.id, [hash])).get(hash);
  if (size === undefined || size > limits.backendCodeBytes) {
    throw new ApiError("too_large", "This backend is too big.", { limit: limits.backendCodeBytes });
  }
  const object = await deps.bucket.get(blobKey(hash));
  if (!object) throw new ApiError("not_found", "This version has no backend.");
  const code = new TextDecoder().decode(object.body);

  // Everything about who may do what stays here, in the app, for the length of this request.
  const canComment = can(caller, "artifact.comment", artifact);
  const scope = {
    orgId: org.id,
    artifactId: payload.a,
    callerId: key,
    readOnly: artifact.archivedAt !== null || !canComment,
    limits,
  };
  const role = caller.kind === "person" ? caller.person.role : "guest";
  const identity = {
    id: pseudonym(org, payload.a, key),
    name: payload.c.name,
    kind: role,
    canComment,
    isPublisher: payload.c.isPublisher,
  };
  const { response, logs } = await runInSandbox({
    run: (job) => pool.run(payload.a, job),
    hash,
    code: () => code,
    limits,
    // The backend's X-Caller is this, never the client's own (08).
    caller: identity,
    request: {
      method: c.req.method,
      path,
      search: new URL(c.req.url).search,
      contentType: c.req.header("content-type") ?? null,
      body,
    },
    onData: async (op) => {
      try {
        return await applyData(deps, scope, op);
      } catch (error) {
        if (error instanceof PreconditionFailed)
          return { error: { code: "precondition_failed", message: error.message } };
        if (error instanceof ApiError) return { error: { code: error.code, message: error.message } };
        throw error;
      }
    },
  });

  const bytes = logs.reduce((sum, line) => sum + Buffer.byteLength(line.message), 0);
  if (logs.length > 0 && deps.limits.spend(`logs:${payload.a}`, bytes, LOG_BYTES_PER_MINUTE, MINUTE)) {
    // A log that can't be saved isn't this request's failure.
    await deps.db
      .insert(backendLogs)
      .values(
        logs.map((line) => ({
          ...line,
          id: Bun.randomUUIDv7(),
          orgId: org.id,
          artifactId: payload.a,
          version: payload.v,
          requestId: c.get("requestId" as never) as string,
          createdAt: deps.clock.now(),
        })),
      )
      .catch((error) => deps.log.warn(`couldn't save backend logs: ${error}`));
  }

  return response;
}
