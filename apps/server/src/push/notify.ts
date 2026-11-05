import { PushSubscribe } from "@artifacts/schema";
import { and, eq, gt, inArray, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import type { LoadedArtifact } from "../api/artifacts-db.ts";
import { findArtifact, findArtifacts } from "../api/artifacts-db.ts";
import type { Deps } from "../api/deps.ts";
import { type ApiContext, parseBody, type Routes } from "../api/routes.ts";
import type { Caller } from "../auth/caller.ts";
import { seesArtifact } from "../auth/can.ts";
import { findOrg } from "../db/index.ts";
import {
  activity,
  artifacts,
  comments,
  org,
  people,
  projects,
  pushSubscriptions,
  sessions,
  threads,
} from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { encryptPayload, generateVapid, vapidHeader } from "./webpush.ts";

const DAY = 24 * 3600_000;
const DIGEST_GAP = 20 * 3600_000;
const TIMEOUT_MS = 10_000;
const MAX_SUBSCRIPTIONS_PER_PERSON = 10;

/**
 * The server POSTs to whatever endpoint a browser hands it, so it only ever calls the real push
 * services. Anything else would let a signed-in person aim the server at its own private network.
 */
const PUSH_HOST =
  /^(fcm\.googleapis\.com|[a-z0-9-]+\.push\.apple\.com|([a-z0-9-]+\.)?push\.services\.mozilla\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

export const isPushEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.port === "" && PUSH_HOST.test(url.hostname);
  } catch {
    return false;
  }
};

const allowed = (deps: Deps, endpoint: string) => (deps.pushAllow ?? isPushEndpoint)(endpoint);

/** Made when first needed: on first boot there may be no org yet. The WHERE settles a race. */
export async function vapidKeys(deps: Deps) {
  const current = await findOrg(deps.db);
  if (!current) throw new ApiError("not_found", "Not found.");
  if (current.vapidPublic && current.vapidPrivate) {
    return { publicKey: current.vapidPublic, privateKey: current.vapidPrivate };
  }
  const fresh = generateVapid();
  await deps.db
    .update(org)
    .set({ vapidPublic: fresh.publicKey, vapidPrivate: fresh.privateKey })
    .where(and(eq(org.id, current.id), isNull(org.vapidPublic)));
  const saved = await findOrg(deps.db);
  return { publicKey: saved?.vapidPublic as string, privateKey: saved?.vapidPrivate as string };
}

/** What can() needs to answer for someone who isn't the one making this request. */
const asCaller = (person: typeof people.$inferSelect): Caller => ({
  kind: "person",
  person,
  sessionId: "",
  recentAuth: false,
});

type Message = { title: string; body: string; url: string; tag: string };

async function send(
  deps: Deps,
  keys: { publicKey: string; privateKey: string },
  row: typeof pushSubscriptions.$inferSelect,
  message: Message,
) {
  if (!allowed(deps, row.endpoint)) return;
  const response = await fetch(row.endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: vapidHeader(new URL(row.endpoint).origin, deps.env.publicUrl, keys, deps.clock.now()),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(DAY / 1000),
      Urgency: "normal",
    },
    body: encryptPayload(JSON.stringify(message), row.keys as { p256dh: string; auth: string }),
  });
  if (response.status === 404 || response.status === 410) {
    await deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
  } else if (response.ok) {
    await deps.db
      .update(pushSubscriptions)
      .set({ lastOkAt: deps.clock.now() })
      .where(eq(pushSubscriptions.id, row.id));
  } else {
    deps.log.warn("a push service refused a message", { status: response.status });
  }
}

/** Devices someone is still signed in on: a session that ended can't be told anything. */
const devices = (deps: Deps, where?: SQL) =>
  deps.db
    .select({ subscription: pushSubscriptions, person: people })
    .from(pushSubscriptions)
    .innerJoin(people, eq(people.id, pushSubscriptions.personId))
    .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
    .where(and(where, isNull(people.removedAt), gt(sessions.expiresAt, deps.clock.now())));

/** Sends to everyone listed who has a device and can still see the artifact. Never throws. */
async function deliver(deps: Deps, resource: LoadedArtifact, personIds: string[], message: Message) {
  try {
    if (personIds.length === 0) return;
    const rows = await devices(deps, inArray(pushSubscriptions.personId, personIds));
    const keys = rows.length > 0 ? await vapidKeys(deps) : null;
    await Promise.all(
      rows
        .filter(({ person }) => seesArtifact(asCaller(person), resource))
        .map(({ subscription }) =>
          send(deps, keys as NonNullable<typeof keys>, subscription, message).catch((error) =>
            deps.log.warn("couldn't send a push", { error: String(error) }),
          ),
        ),
    );
  } catch (error) {
    deps.log.warn("couldn't send pushes", { error: String(error) });
  }
}

/** An agent's new version goes to the publisher and everyone who has commented (SPEC §7.6). */
export async function notifyPublished(
  deps: Deps,
  orgId: string,
  artifactId: string,
  options: { project: string; slug: string; title: string; version: number; agent: string | null },
) {
  if (!options.agent) return;
  const resource = await findArtifact(deps, orgId, artifactId);
  if (!resource) return;
  const commenters = await deps.db
    .selectDistinct({ id: comments.authorPersonId })
    .from(comments)
    .innerJoin(threads, eq(threads.id, comments.threadId))
    .where(eq(threads.artifactId, artifactId));
  // Including the person whose token the agent uses: they weren't watching it happen.
  const ids = new Set([resource.publisherId, ...commenters.map((row) => row.id)]);
  await deliver(
    deps,
    resource,
    [...ids].filter((id): id is string => Boolean(id)),
    {
      title: `${options.agent} published v${options.version}`,
      body: options.title,
      // A path, so an app installed on any of the server's domains stays on that domain.
      url: `/${options.project}/${options.slug}`,
      tag: `artifact-${artifactId}`,
    },
  );
}

/**
 * A reply goes to everyone else in the thread, and tapping it opens that comment. `actor` is null for
 * an agent, which writes with its person's token and still has news for them.
 */
export async function notifyReply(
  deps: Deps,
  orgId: string,
  thread: { id: string; n: number; pageKey: string; artifactId: string; authorPersonId: string | null },
  reply: { authorName: string; body: string; actor: string | null },
) {
  const resource = await findArtifact(deps, orgId, thread.artifactId);
  if (!resource) return;
  const rows = await deps.db
    .selectDistinct({ id: comments.authorPersonId })
    .from(comments)
    .where(eq(comments.threadId, thread.id));
  const ids = new Set([thread.authorPersonId, ...rows.map((row) => row.id)]);
  ids.delete(reply.actor);
  const [path] = await deps.db
    .select({ project: projects.slug, slug: artifacts.slug })
    .from(artifacts)
    .innerJoin(projects, eq(projects.id, artifacts.projectId))
    .where(eq(artifacts.id, thread.artifactId));
  if (!path) return;
  await deliver(
    deps,
    resource,
    [...ids].filter((id): id is string => Boolean(id)),
    {
      title: `${reply.authorName} replied`,
      body: reply.body.slice(0, 160),
      url: `/${path.project}/${path.slug}/${thread.pageKey}?c=${thread.n}`,
      tag: `thread-${thread.id}`,
    },
  );
}

/** The daily digest: what happened on artifacts each person can see, if anything did and not by them. */
export async function sendDigest(deps: Deps) {
  const current = await findOrg(deps.db);
  if (!current) return;
  const since = new Date(deps.clock.now().getTime() - DAY);
  // A claim, so a restart or a second replica doesn't send it twice.
  const claimed = await deps.db
    .update(org)
    .set({ lastDigestAt: deps.clock.now() })
    .where(
      and(
        eq(org.id, current.id),
        or(isNull(org.lastDigestAt), lt(org.lastDigestAt, new Date(deps.clock.now().getTime() - DIGEST_GAP))),
      ),
    )
    .returning({ id: org.id });
  if (claimed.length === 0) return;
  const rows = await devices(deps);
  if (rows.length === 0) return;
  const recent = await deps.db
    .select()
    .from(activity)
    .where(and(eq(activity.orgId, current.id), gt(activity.createdAt, since)));
  const resources = await findArtifacts(deps, current.id, [
    ...new Set(recent.flatMap(({ artifactId }) => (artifactId ? [artifactId] : []))),
  ]);
  const keys = await vapidKeys(deps);
  const people_ = new Map(rows.map((row) => [row.person.id, row.person]));
  for (const person of people_.values()) {
    const caller = asCaller(person);
    const count = recent.filter((row) => {
      const resource = row.artifactId ? resources.get(row.artifactId) : null;
      return resource && row.actorPersonId !== person.id && seesArtifact(caller, resource);
    }).length;
    if (count === 0) continue;
    const message = {
      title: "Today in Artifacts",
      body: count === 1 ? "1 update since yesterday" : `${count} updates since yesterday`,
      url: "/activity",
      tag: "digest",
    };
    await Promise.all(
      rows
        .filter((row) => row.person.id === person.id)
        .map(({ subscription }) =>
          send(deps, keys, subscription, message).catch((error) =>
            deps.log.warn("couldn't send a push", { error: String(error) }),
          ),
        ),
    );
  }
}

export function pushRoutes(routes: Routes, deps: Deps) {
  const person = (c: ApiContext) => {
    const caller = c.get("caller");
    if (caller.kind !== "person") throw new ApiError("forbidden", "This needs a signed-in browser.");
    return caller.person;
  };

  routes.get("/api/push/key", { action: "account.manage" }, async (c) => {
    return c.json({ key: (await vapidKeys(deps)).publicKey });
  });

  routes.post("/api/push/subscribe", { action: "account.manage" }, async (c) => {
    const me = person(c as ApiContext);
    const session = (c.get("caller") as { sessionId: string }).sessionId;
    const body = await parseBody(c, PushSubscribe);
    if (!allowed(deps, body.endpoint)) throw new ApiError("invalid", "That isn't a push service.");
    // A browser's keys are an uncompressed P-256 point and 16 bytes of secret; anything else can't be sent to.
    const point = Buffer.from(body.keys.p256dh, "base64url");
    if (point.length !== 65 || point[0] !== 4 || Buffer.from(body.keys.auth, "base64url").length !== 16) {
      throw new ApiError("invalid", "Those aren't a browser's push keys.");
    }
    const existing = await deps.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.personId, me.id), ne(pushSubscriptions.endpoint, body.endpoint)));
    if (existing.length >= MAX_SUBSCRIPTIONS_PER_PERSON) {
      throw new ApiError("conflict", "Too many devices have notifications on. Turn some off first.");
    }
    await deps.db
      .insert(pushSubscriptions)
      .values({
        id: Bun.randomUUIDv7(),
        orgId: c.get("org").id,
        personId: me.id,
        sessionId: session,
        endpoint: body.endpoint,
        keys: body.keys,
        createdAt: deps.clock.now(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { personId: me.id, sessionId: session, keys: body.keys },
      });
    return c.json({ ok: true });
  });

  routes.delete("/api/push/subscribe", { action: "account.manage" }, async (c) => {
    const me = person(c as ApiContext);
    const { endpoint } = await parseBody(c, PushSubscribe.pick({ endpoint: true }));
    await deps.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.personId, me.id), eq(pushSubscriptions.endpoint, endpoint)));
    return c.json({ ok: true });
  });
}
