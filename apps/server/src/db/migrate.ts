import { existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATION_LOCK = 7_316_001;

/** `drizzle/` sits beside server.js in the image, and beside src/ in the repo. */
function migrationsFolder(): string {
  const here = import.meta.dir;
  const found = [join(here, "drizzle"), join(here, "../drizzle"), join(here, "../../drizzle")].find((dir) =>
    existsSync(join(dir, "meta/_journal.json")),
  );
  if (!found) throw new Error(`No migrations found near ${here}`);
  return found;
}

/**
 * Runs migrations under an advisory lock, so only one replica migrates (09). The lock belongs to a
 * session, so this uses a single connection rather than the pool.
 */
export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle({ client }), { migrationsFolder: migrationsFolder() });
  } finally {
    await client.end({ timeout: 5 });
  }
}
