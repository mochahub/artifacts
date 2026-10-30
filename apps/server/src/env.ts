import { getDomain } from "tldts";
import { z } from "zod";

const Secret = z.string().min(32, "must be at least 32 characters");

const Origin = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/" && !url.search) {
      return url.origin;
    }
  } catch {}
  ctx.addIssue({ code: "custom", message: `"${value}" isn't a plain http(s) origin` });
  return z.NEVER;
});

const Port = (fallback: number) => z.coerce.number().int().min(0).max(65535).default(fallback);

// Variables owned by 09-deploy.md.
const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: Origin,
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  S3_PUBLIC_ENDPOINT: Origin.optional(),
  PUBLIC_URL: Origin,
  MORE_URLS: z.string().default(""),
  CONTENT_URL: Origin.optional(),
  SETUP_TOKEN: Secret,
  SESSION_SECRET: Secret,
  OPS_SECRET: Secret,
  PORT: Port(8080),
  CONTENT_PORT: Port(8081),
  INTERNAL_PORT: Port(8082),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  GITHUB_RELEASES_REPO: z.string().optional(),
});

export type Env = {
  databaseUrl: string;
  s3: {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  publicUrl: string;
  viewerOrigins: string[];
  contentUrl: string | null;
  setupToken: string;
  sessionSecret: string;
  opsSecret: string;
  port: number;
  contentPort: number;
  internalPort: number;
  logLevel: z.infer<typeof Schema>["LOG_LEVEL"];
  githubReleasesRepo: string | null;
};

export class EnvError extends Error {
  override name = "EnvError";
}

const siteOf = (hostname: string) => getDomain(hostname, { allowPrivateDomains: true });

/** Parses the environment. Throws EnvError listing every problem; returns warnings to log. */
export function parseEnv(raw: Record<string, string | undefined>): { env: Env; warnings: string[] } {
  // Railway and Compose hand unset variables through as empty strings.
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ""));
  const parsed = Schema.safeParse(present);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    );
  }
  const v = parsed.data;

  const more = v.MORE_URLS.split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => {
      const origin = Origin.safeParse(url);
      if (!origin.success) throw new EnvError(`MORE_URLS: "${url}" isn't a plain http(s) origin`);
      return origin.data;
    });
  const viewerOrigins = [...new Set([v.PUBLIC_URL, ...more])];

  const warnings: string[] = [];
  if (v.CONTENT_URL) {
    const content = new URL(v.CONTENT_URL).hostname;
    for (const origin of viewerOrigins) {
      const viewer = new URL(origin).hostname;
      if (viewer === content) {
        throw new EnvError(`CONTENT_URL: ${content} is also a viewer host; Live previews need their own`);
      }
      if (siteOf(viewer) && siteOf(viewer) === siteOf(content)) {
        warnings.push(
          `CONTENT_URL (${content}) and ${viewer} share a registrable domain, so they're the same site, ` +
            "which weakens the isolation of Live previews",
        );
      }
    }
  }

  return {
    warnings,
    env: {
      databaseUrl: v.DATABASE_URL,
      s3: {
        endpoint: v.S3_ENDPOINT,
        publicEndpoint: v.S3_PUBLIC_ENDPOINT ?? v.S3_ENDPOINT,
        region: v.S3_REGION,
        bucket: v.S3_BUCKET,
        accessKeyId: v.S3_ACCESS_KEY_ID,
        secretAccessKey: v.S3_SECRET_ACCESS_KEY,
        forcePathStyle: v.S3_FORCE_PATH_STYLE === "true",
      },
      publicUrl: v.PUBLIC_URL,
      viewerOrigins,
      contentUrl: v.CONTENT_URL ?? null,
      setupToken: v.SETUP_TOKEN,
      sessionSecret: v.SESSION_SECRET,
      opsSecret: v.OPS_SECRET,
      port: v.PORT,
      contentPort: v.CONTENT_PORT,
      internalPort: v.INTERNAL_PORT,
      logLevel: v.LOG_LEVEL,
      githubReleasesRepo: v.GITHUB_RELEASES_REPO ?? null,
    },
  };
}
