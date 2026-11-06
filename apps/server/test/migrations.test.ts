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

  // Which tables, exactly, is data-model.test.ts's job; here it's that every way of applying gives the same.
  const tables = (on = sql) =>
    on`select table_name from information_schema.tables where table_schema = 'public' order by 1`.then(
      (rows) => rows.map((row) => row.table_name as string),
    );
  let applied: string[] = [];

  test("apply to an empty database", async () => {
    expect(await tables()).toEqual([]);
    await runMigrations(database.url);
    applied = await tables();
    expect(applied).toEqual(expect.arrayContaining(["org", "people", "artifacts", "versions"]));
  });

  test("apply again without error or change", async () => {
    const before = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    await runMigrations(database.url);
    const after = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(after).toEqual(before);
    expect(await tables()).toEqual(applied);
  });

  test("two replicas booting together both succeed", async () => {
    const fresh = await createDatabase();
    try {
      await Promise.all([runMigrations(fresh.url), runMigrations(fresh.url), runMigrations(fresh.url)]);
      const check = postgres(fresh.url, { max: 1 });
      const made = await tables(check);
      await check.end();
      expect(made).toEqual(applied);
    } finally {
      await fresh.drop();
    }
  });
});
