import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate.ts";
import { createDatabase } from "./helpers.ts";

describe("migrations", () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    database = await createDatabase();
    sql = postgres(database.url, { max: 1 });
  });
  afterAll(async () => {
    await sql.end();
    await database.drop();
  });

  const tables = () =>
    sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`.then(
      ([row]) => row?.n as number,
    );

  test("apply to an empty database", async () => {
    expect(await tables()).toBe(0);
    await runMigrations(database.url);
    expect(await tables()).toBe(28);
  });

  test("apply again without error or change", async () => {
    const before = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await runMigrations(database.url);
    const after = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(after).toEqual(before);
    expect(await tables()).toBe(28);
  });

  test("two replicas booting together both succeed", async () => {
    const fresh = await createDatabase();
    try {
      await Promise.all([runMigrations(fresh.url), runMigrations(fresh.url), runMigrations(fresh.url)]);
      const check = postgres(fresh.url, { max: 1 });
      const [row] =
        await check`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
      await check.end();
      expect(row?.n).toBe(28);
    } finally {
      await fresh.drop();
    }
  });
});
