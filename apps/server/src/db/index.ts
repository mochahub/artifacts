import { Brand, DEFAULT_ORG_SETTINGS, type OrgSettings } from "@artifacts/schema";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof connect>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function connect(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle({ client, schema }), close: () => client.end({ timeout: 5 }) };
}

export type OrgRow = Omit<typeof schema.org.$inferSelect, "settings" | "brand"> & {
  settings: OrgSettings;
  brand: Brand | null;
};

/** The deployment's one organization; null means setup mode (04). */
export async function findOrg(db: Db): Promise<OrgRow | null> {
  const [row] = await db.select().from(schema.org).orderBy(asc(schema.org.id)).limit(1);
  if (!row) return null;
  // Stored before a setting existed, it takes the default, and nothing needs rewriting.
  const brand = Brand.safeParse(row.brand);
  return {
    ...row,
    settings: { ...DEFAULT_ORG_SETTINGS, ...row.settings },
    brand: brand.success ? brand.data : null,
  };
}

/** Postgres refused a duplicate: two requests raced for one unique value, and the index settled it. */
export const isUniqueViolation = (error: unknown) => {
  const { code, cause } = error as { code?: string; cause?: { code?: string } };
  return (cause?.code ?? code) === "23505";
};

/** A LIKE pattern matching `text` anywhere, with its own `%`, `_` and `\\` taken literally. */
export const containing = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
