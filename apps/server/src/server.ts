import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { routePath } from "hono/route";
import type { Deps } from "./api/deps.ts";
import { mountApi } from "./api/index.ts";
import { metaRoutes, viewerOrigins } from "./api/meta.ts";
import { type ApiVars, Routes } from "./api/routes.ts";
import { RateLimits } from "./auth/rate-limit.ts";
import { type Clock, systemClock } from "./clock.ts";
import { createContentApp } from "./content/app.ts";
import { connect, findOrg } from "./db/index.ts";
import { runMigrations } from "./db/migrate.ts";
import { type Env, EnvError } from "./env.ts";
import { createApp } from "./http/app.ts";
import { apiGuards } from "./http/guards.ts";
import { requireViewerHost, serveViewer, viewerHeaders } from "./http/viewer.ts";
import { wellKnownWebauthn } from "./http/well-known.ts";
import { createInternalApp } from "./internal/app.ts";
import { jobsFor, startJobs } from "./jobs/index.ts";
import type { Logger } from "./log.ts";
import { Bucket, bucketOrigin } from "./s3.ts";

export type StartOptions = {
  log: Logger;
  clock?: Clock;
  /** The built viewer. Found automatically: beside server.js in the image, in apps/viewer in the repo. */
  viewerDir?: string | null;
  /** Called with every API route served; tests use it to prove each route was exercised. */
  onRoute?: (method: string, path: string) => void;
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

  const deps: Deps = {
    env,
    db,
    bucket,
    clock,
    log,
    limits: new RateLimits(clock),
    origins: async () => viewerOrigins(env, await currentHomeDomain()),
    clientIp,
  };

  const viewer = createApp(log) as unknown as ReturnType<typeof createApp> & import("hono").Hono<ApiVars>;
  viewer.use(viewerHeaders(env, bucketOrigin(env.s3)));
  // Exempt from the host check: Railway's and Docker's health checks send their own Host.
  const viewerHost = requireViewerHost(env, currentHomeDomain);
  viewer.use((c, next) => (c.req.path === "/api/health" ? next() : viewerHost(c, next)));
  viewer.use(apiGuards(deps));
  if (options.onRoute) {
    const record = options.onRoute;
    viewer.use("/api/*", async (c, next) => {
      await next();
      record(c.req.method, routePath(c));
    });
  }
  metaRoutes(viewer, env, db);
  viewer.get("/.well-known/webauthn", wellKnownWebauthn(deps));
  const routes = new Routes(viewer);
  mountApi(routes, deps);
  viewer.all("/api/*", (c) => c.notFound());
  viewer.get("*", serveViewer(options.viewerDir === undefined ? findViewerDir() : options.viewerDir));

  const servers = [
    Bun.serve({ port: env.port, fetch: viewer.fetch }),
    Bun.serve({ port: env.contentPort, fetch: createContentApp(deps).fetch }),
    Bun.serve({ port: env.internalPort, fetch: createInternalApp(env, log, jobsFor(deps)).fetch }),
  ] as const;
  const [viewerServer, contentServer, internalServer] = servers;
  const stopJobs = startJobs(deps);
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
    async stop() {
      stopJobs();
      await Promise.all(servers.map((server) => server.stop(true)));
      await close();
    },
  };
}
