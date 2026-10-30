import { existsSync } from "node:fs";
import { join } from "node:path";
import { metaRoutes, viewerOrigins } from "./api/meta.ts";
import { type Clock, systemClock } from "./clock.ts";
import { createContentApp } from "./content/app.ts";
import { connect, findOrg } from "./db/index.ts";
import { runMigrations } from "./db/migrate.ts";
import { type Env, EnvError } from "./env.ts";
import { createApp } from "./http/app.ts";
import { requireViewerHost, serveViewer, viewerHeaders } from "./http/viewer.ts";
import { createInternalApp } from "./internal/app.ts";
import type { Logger } from "./log.ts";
import { Bucket, bucketOrigin } from "./s3.ts";

export type StartOptions = {
  log: Logger;
  clock?: Clock;
  /** The built viewer. Found automatically: beside server.js in the image, in apps/viewer in the repo. */
  viewerDir?: string | null;
};

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

  const viewer = createApp(log);
  viewer.use(viewerHeaders(env, bucketOrigin(env.s3)));
  // Exempt from the host check: Railway's and Docker's health checks send their own Host.
  const viewerHost = requireViewerHost(env, currentHomeDomain);
  viewer.use((c, next) => (c.req.path === "/api/health" ? next() : viewerHost(c, next)));
  metaRoutes(viewer, env, db);
  viewer.all("/api/*", (c) => c.notFound());
  viewer.get("*", serveViewer(options.viewerDir === undefined ? findViewerDir() : options.viewerDir));

  const servers = [
    Bun.serve({ port: env.port, fetch: viewer.fetch }),
    Bun.serve({ port: env.contentPort, fetch: createContentApp(env, log).fetch }),
    Bun.serve({ port: env.internalPort, fetch: createInternalApp(env, log).fetch }),
  ] as const;
  const [viewerServer, contentServer, internalServer] = servers;
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
    async stop() {
      await Promise.all(servers.map((server) => server.stop(true)));
      await close();
    },
  };
}
