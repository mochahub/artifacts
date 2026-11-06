import type { Health, Meta } from "@artifacts/schema";
import { type Db, findOrg } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { createApp } from "../http/app.ts";
import { viewerOrigins } from "../http/origins.ts";
import { MIN_CLI_VERSION, VERSION } from "../version.ts";

export function metaRoutes(app: ReturnType<typeof createApp>, env: Env, db: Db) {
  app.get("/api/health", async (c) => {
    const body: Health = { ok: true, version: VERSION, setupMode: (await findOrg(db)) === null };
    return c.json(body);
  });

  app.get("/api/meta", async (c) => {
    const org = await findOrg(db);
    const body: Meta = {
      version: VERSION,
      minCliVersion: MIN_CLI_VERSION,
      orgName: org?.name ?? null,
      homeDomain: org?.homeDomain ?? null,
      publicUrl: env.publicUrl,
      contentUrl: env.contentUrl,
      viewerOrigins: viewerOrigins(env, org?.homeDomain ?? null),
      google: Boolean(org?.googleEnabled && org.googleClientId),
    };
    return c.json(body);
  });
}
