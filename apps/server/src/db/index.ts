import type { OrgSettings } from "@artifacts/schema";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof connect>["db"];

export function connect(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle({ client, schema }), close: () => client.end({ timeout: 5 }) };
}

export type OrgRow = Omit<typeof schema.org.$inferSelect, "settings"> & { settings: OrgSettings };

/** The deployment's one organization; null means setup mode (04). */
export async function findOrg(db: Db): Promise<OrgRow | null> {
  const [row] = await db.select().from(schema.org).orderBy(asc(schema.org.id)).limit(1);
  return (row as OrgRow | undefined) ?? null;
}
