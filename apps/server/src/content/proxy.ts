import { and, eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { findArtifact } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import type { Caller } from "../auth/caller.ts";
import { can } from "../auth/can.ts";
import {
  callerKey,
  checkKey,
  dataPrefix,
  deleteValue,
  listKeys,
  pseudonym,
  putValue,
} from "../data/store.ts";
import { findOrg } from "../db/index.ts";
import { backendLogs, versions } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { blobKey } from "../publish/blobs.ts";
import { PreconditionFailed } from "../s3.ts";
import type { SandboxPool } from "../sandbox/pool.ts";
import type { ContentPayload } from "./token.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600",
};
const MINUTE = 60_000;
/** Only these reach the browser: a backend can't set cookies, or anything else on the content origin. */
const SAFE_HEADERS = new Set(["content-type", "cache-control", "etag", "last-modified"]);

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS });

type Op = {
  op: "get" | "put" | "delete" | "list";
  key?: string;
  prefix?: string;
  value?: unknown;
  ifMatch?: string;
};

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
    readOnly: boolean;
    limits: Awaited<ReturnType<typeof orgOf>>["settings"]["limits"];
  },
  raw: string,
) {
  const op = JSON.parse(raw) as Op;
  if (op.op === "get") {
    const object = await deps.bucket.get(objectPath(scope.artifactId, op.key ?? "").key);
    return { value: object ? JSON.parse(new TextDecoder().decode(object.body)) : null };
  }
  if (op.op === "list") {
    const base = `${dataPrefix(scope.artifactId)}shared/`;
    const page = await listKeys(deps, `${base}${op.prefix ? checkKey(op.prefix) : ""}`);
    return { value: page.keys.map((entry) => `${op.prefix ?? ""}${entry.key}`) };
  }
  if (scope.readOnly) throw new ApiError("read_only", "This caller can only read.");
  const path = objectPath(scope.artifactId, op.key ?? "");
  if (op.op === "put") {
    await putValue(deps, {
      orgId: scope.orgId,
      artifactId: scope.artifactId,
      scope: path.scope,
      objectKey: path.key,
      value: op.value,
      limits: scope.limits,
      ifMatch: op.ifMatch,
    });
    return { value: true };
  }
  await deleteValue(deps, {
    orgId: scope.orgId,
    artifactId: scope.artifactId,
    scope: path.scope,
    objectKey: path.key,
  });
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

  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > limits.backendRequestBytes) {
    throw new ApiError("too_large", "That request is too big.", { limit: limits.backendRequestBytes });
  }
  const body = await c.req.text();
  if (Buffer.byteLength(body) > limits.backendRequestBytes) {
    throw new ApiError("too_large", "That request is too big.", { limit: limits.backendRequestBytes });
  }

  const object = await deps.bucket.get(blobKey(hash));
  if (!object) throw new ApiError("not_found", "This version has no backend.");
  const code = new TextDecoder().decode(object.body);
  if (Buffer.byteLength(code) > limits.backendCodeBytes) {
    throw new ApiError("too_large", "This backend is too big.", { limit: limits.backendCodeBytes });
  }

  // Everything about who may do what stays here, in the app, for the length of this request.
  const canComment = can(caller, "artifact.comment", artifact);
  const scope = {
    orgId: org.id,
    artifactId: payload.a,
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
  const url = new URL(c.req.url);
  const { response, logs } = await pool.run({
    hash,
    code: () => code,
    limits: { timeoutMs: limits.backendTimeoutMs, memoryMb: limits.backendMemoryMb },
    request: {
      url: `https://backend.invalid/api/${path}${url.search}`,
      method: c.req.method,
      headers: {
        ...(c.req.header("content-type") ? { "content-type": c.req.header("content-type") as string } : {}),
        // Set here, so a client's own X-Caller never reaches the backend (08).
        "x-caller": JSON.stringify(identity),
      },
      body,
    },
    onData: async (raw: unknown) => {
      try {
        return await applyData(deps, scope, raw as string);
      } catch (error) {
        if (error instanceof PreconditionFailed)
          return { error: { code: "precondition_failed", message: error.message } };
        if (error instanceof ApiError) return { error: { code: error.code, message: error.message } };
        throw error;
      }
    },
  });

  if (logs.length > 0) {
    await deps.db.insert(backendLogs).values(
      logs.slice(0, 100).map((line) => ({
        id: Bun.randomUUIDv7(),
        orgId: org.id,
        artifactId: payload.a,
        version: payload.v,
        level: line.level,
        message: line.message.slice(0, 8192),
        requestId: c.get("requestId" as never) as string,
        createdAt: deps.clock.now(),
      })),
    );
  }

  if (Buffer.byteLength(response.body) > limits.backendResponseBytes) {
    return new Response('{"error":"The response is too big."}', {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const headers = new Headers(CORS);
  for (const [name, value] of response.headers)
    if (SAFE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

export const expireLogs = (deps: Deps) =>
  deps.db
    .delete(backendLogs)
    .where(lt(backendLogs.createdAt, new Date(deps.clock.now().getTime() - 24 * 3600_000)));
