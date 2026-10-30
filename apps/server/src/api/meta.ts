import type { Health, Meta } from "@artifacts/schema";
import { type Db, findOrg } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { createApp } from "../http/app.ts";
import { MIN_CLI_VERSION, VERSION } from "../version.ts";

/** The viewer origins: PUBLIC_URL, MORE_URLS and always the home domain (SPEC §7.3). */
export function viewerOrigins(env: Env, homeDomain: string | null): string[] {
  const known = env.viewerOrigins;
  if (!homeDomain || known.some((origin) => new URL(origin).hostname === homeDomain)) return known;
  return [...known, `https://${homeDomain}`];
}

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
    };
    return c.json(body);
  });
}
