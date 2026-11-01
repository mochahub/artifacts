import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Brand, OrgBrand } from "@artifacts/schema";
import { findClient } from "../commands/account.ts";
import { configDir, pickServer } from "../config.ts";
import type { Output } from "../output.ts";

/** A render shouldn't wait long on a server it can do without. */
const GIVE_UP_MS = 3000;

export type LocalBrand = Brand & { fontFiles: Map<string, string> };

const folder = (url: string) =>
  join(configDir(), "brand", createHash("sha256").update(url).digest("hex").slice(0, 16));

function fromCache(dir: string): { brand: Brand | null; fetchedAt: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, "brand.json"), "utf8"));
  } catch {
    return null;
  }
}

const withFiles = (brand: Brand, dir: string): LocalBrand => ({
  ...brand,
  fontFiles: new Map(
    brand.fonts.flatMap((font) => {
      const path = join(dir, "fonts", `${font.hash}.${font.format}`);
      return existsSync(path) ? [[font.hash, path] as const] : [];
    }),
  ),
});

async function refresh(url: string, dir: string, now: Date) {
  const client = await findClient();
  if (!client) return null;
  const body = OrgBrand.parse(await client.get("/api/brand"));
  for (const font of body.brand?.fonts ?? []) {
    const path = join(dir, "fonts", `${font.hash}.${font.format}`);
    if (existsSync(path)) continue;
    const link = body.fonts.find((entry) => entry.hash === font.hash)?.url;
    if (!link) continue;
    const bytes = new Uint8Array(await (await fetch(link)).arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== font.hash) continue;
    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(path, bytes);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "brand.json"),
    JSON.stringify({ brand: body.brand, fetchedAt: now.toISOString(), url }),
  );
  if (!body.brand) rmSync(join(dir, "fonts"), { recursive: true, force: true });
  return { brand: body.brand };
}

/**
 * The org's brand for rendering: fresh when the server answers quickly, or the cached copy, so work
 * goes on offline. With no server configured there's simply no brand.
 */
export async function loadBrand(out: Output): Promise<LocalBrand | null> {
  let url: string;
  try {
    url = pickServer();
  } catch {
    return null;
  }
  const dir = folder(url);
  const fresh = await Promise.race([
    refresh(url, dir, new Date()).catch(() => null),
    new Promise<null>((resolve) => setTimeout(resolve, GIVE_UP_MS, null)),
  ]);
  if (fresh) return fresh.brand ? withFiles(fresh.brand, dir) : null;
  const cached = fromCache(dir);
  if (!cached?.brand) return null;
  out.warn(`! Couldn't reach ${url}, so this uses the brand cached on ${cached.fetchedAt.slice(0, 10)}.`);
  return withFiles(cached.brand, dir);
}
