import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ORG_SETTINGS } from "@artifacts/schema";
import type { Context } from "hono";
import { mountApi } from "./api/index.ts";
import { metaRoutes } from "./api/meta.ts";
import { type GoogleProvider, googleProvider } from "./auth/google.ts";
import { RateLimits } from "./auth/rate-limit.ts";
import { type Clock, systemClock } from "./clock.ts";
import { createContentApp } from "./content/app.ts";
import { connect, findOrg } from "./db/index.ts";
import { runMigrations } from "./db/migrate.ts";
import type { Deps } from "./deps.ts";
import { type Env, EnvError } from "./env.ts";
import { createApp } from "./http/app.ts";
import { apiGuards } from "./http/guards.ts";
import { MCP_PATH, viewerOrigins } from "./http/origins.ts";
import { artifactParam } from "./http/resources.ts";
import { type ApiVars, Routes } from "./http/routes.ts";
import { requireViewerHost, serveViewer, viewerHeaders } from "./http/viewer.ts";
import { wellKnownWebauthn } from "./http/well-known.ts";
import { createInternalApp } from "./internal/app.ts";
import { jobsFor, startJobs } from "./jobs/index.ts";
import type { Logger } from "./log.ts";
import { mcpChallenge } from "./mcp/routes.ts";
import { fetchMetadata, type MetadataFetch } from "./oauth/metadata.ts";
import { isPushEndpoint } from "./push/notify.ts";
import { Events } from "./realtime/events.ts";
import { DocHub, syncRoute, syncSocket } from "./realtime/sync.ts";
import { Bucket, bucketOrigin } from "./s3.ts";
import { SandboxPool } from "./sandbox/pool.ts";

export type StartOptions = {
  log: Logger;
  clock?: Clock;
  /** The built viewer. Found automatically: beside server.js in the image, in apps/viewer in the repo. */
  viewerDir?: string | null;
  /** Runs the daily jobs on a timer. Without it they run only when POST /internal/jobs/:name asks. */
  jobs?: boolean;
  /** The services outside: Google, the browsers' push services and OAuth clients' metadata documents. */
  google?: GoogleProvider;
  pushAllow?: (endpoint: string) => boolean;
  clientMetadata?: MetadataFetch;
  /** How often an open event stream checks that its caller can still see the artifact. */
  heartbeatMs?: number;
};

const PRIVATE_PEER = /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/;

/**
 * The real client behind one proxy: Railway and a reverse proxy reach us from a private address and
 * append the client as the last X-Forwarded-For entry. A public peer is the client itself.
 */
function clientIp(c: Context): string {
  const server = c.env as { requestIP?(request: Request): { address: string } | null } | undefined;
  const peer = server?.requestIP?.(c.req.raw)?.address ?? "unknown";
  const forwarded = c.req.header("x-forwarded-for");
  if (!forwarded || !PRIVATE_PEER.test(peer)) return peer;
  return forwarded.split(",").at(-1)?.trim() || peer;
}

function findViewerDir(): string | null {
  const here = import.meta.dir;
  const candidates = [join(here, "public"), join(here, "../../viewer/dist")];
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

/** The boot sequence in 09. */
export async function startServer(env: Env, options: StartOptions) {
  const { log, clock = systemClock } = options;

  await runMigrations(env.databaseUrl);
  const { db, close } = connect(env.databaseUrl);

  const org = await findOrg(db);
  if (org && env.contentUrl && new URL(env.contentUrl).hostname === org.homeDomain) {
    await close();
    throw new EnvError(
      `CONTENT_URL: ${org.homeDomain} is the home domain; Live previews need their own host`,
    );
  }
  log.info("database ready", { setupMode: org === null });

  const bucket = new Bucket(env.s3, clock);
  try {
    log.info("bucket ready", { bucket: env.s3.bucket, state: await bucket.ensure() });
  } catch (error) {
    // Don't refuse to boot: some bucket credentials can't call HeadBucket, and health shouldn't depend on it.
    log.warn("couldn't check the bucket", { error: String(error) });
  }

  // The home domain never changes once set, so it's safe to keep (02).
  let homeDomain: string | null = org?.homeDomain ?? null;
  const currentHomeDomain = async () => {
    homeDomain ??= (await findOrg(db))?.homeDomain ?? null;
    return homeDomain;
  };

  const events = new Events(env.databaseUrl, undefined, options.heartbeatMs);
  await events.start();
  const docs = new DocHub(env.databaseUrl, log);
  await docs.start();

  const deps: Deps = {
    env,
    db,
    bucket,
    clock,
    log,
    limits: new RateLimits(clock),
    origins: async () => viewerOrigins(env, await currentHomeDomain()),
    clientIp,
    sandbox: new SandboxPool(org?.settings.sandboxProcesses ?? DEFAULT_ORG_SETTINGS.sandboxProcesses, log),
    events,
    pushAllow: options.pushAllow ?? isPushEndpoint,
    clientMetadata: options.clientMetadata ?? fetchMetadata,
    google: options.google ?? googleProvider,
    docs,
  };
  docs.attach(deps);

  const viewer = createApp(log) as unknown as ReturnType<typeof createApp> & import("hono").Hono<ApiVars>;
  viewer.use(viewerHeaders(env, bucketOrigin(env.s3)));
  // Exempt from the host check: Railway's and Docker's health checks send their own Host.
  const viewerHost = requireViewerHost(env, currentHomeDomain);
  viewer.use((c, next) => (c.req.path === "/api/health" ? next() : viewerHost(c, next)));
  viewer.use(MCP_PATH, mcpChallenge(deps));
  viewer.use(apiGuards(deps));
  metaRoutes(viewer, env, db);
  viewer.get("/.well-known/webauthn", wellKnownWebauthn(deps));
  const routes = new Routes(viewer);
  mountApi(routes, deps);
  // The draft's sync socket (13, "Sync"): the guard, then the upgrade into `syncSocket` below.
  routes.get(
    "/api/artifacts/:id/doc/sync",
    { action: "artifact.edit", resource: artifactParam(deps) },
    syncRoute(deps) as never,
  );
  // This transport has no stream to open and no session to end (MCP, Streamable HTTP).
  viewer.on(["GET", "DELETE"], MCP_PATH, (c) => c.body(null, 405, { Allow: "POST" }));
  viewer.all("/api/*", (c) => c.notFound());
  viewer.get("*", serveViewer(options.viewerDir === undefined ? findViewerDir() : options.viewerDir, deps));

  const servers = [
    Bun.serve({ port: env.port, fetch: viewer.fetch, websocket: syncSocket(docs) }),
    Bun.serve({ port: env.contentPort, fetch: createContentApp(deps).fetch }),
    // It takes no body at all, so a large one isn't read, whoever sends it.
    Bun.serve({
      port: env.internalPort,
      maxRequestBodySize: 1024,
      fetch: createInternalApp(env, log, jobsFor(deps)).fetch,
    }),
  ] as const;
  const [viewerServer, contentServer, internalServer] = servers;
  const stopJobs = options.jobs === false ? () => {} : startJobs(deps);
  log.info("listening", {
    port: viewerServer.port,
    contentPort: contentServer.port,
    internalPort: internalServer.port,
    origins: viewerOrigins(env, homeDomain),
  });

  return {
    ports: {
      viewer: viewerServer.port as number,
      content: contentServer.port as number,
      internal: internalServer.port as number,
    },
    db,
    bucket,
    routes: routes.list,
    deps,
    async stop() {
      stopJobs();
      deps.sandbox.stop();
      await docs.stop();
      await Promise.all(servers.map((server) => server.stop(true)));
      await events.stop();
      await close();
    },
  };
}
