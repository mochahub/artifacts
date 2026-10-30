import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_ORG_SETTINGS, Permission, Role } from "@artifacts/schema";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { connect, findOrg } from "../src/db/index.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { artifacts, org, passkeys, people, projects, threads, tokens } from "../src/db/schema.ts";
import { createDatabase } from "./helpers.ts";

/** Reads 02-data-model.md itself, so the code and the contract can't drift apart unnoticed. */
const doc = await Bun.file(join(import.meta.dir, "../../../docs/implementation/02-data-model.md")).text();
const phase2 = new Set(["backend_logs", "artifact_usage", "push_subscriptions"]);

const ticks = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);

function docEnums(): Record<string, string[]> {
  const section = doc.slice(doc.indexOf("## Enums"), doc.indexOf("## Tables"));
  const enums: Record<string, string[]> = {};
  for (const [, name, values] of section.matchAll(/^\| `(\w+)` \| (.+) \|$/gm)) {
    // A note in brackets isn't a value.
    enums[name as string] = ticks((values as string).replace(/\(.*\)/, ""));
  }
  return enums;
}

/** Tables written as `| Column | Type | Notes |`, with their column names. */
function docPipeTables(): Record<string, string[]> {
  const tables: Record<string, string[]> = {};
  for (const [, name, body] of doc.matchAll(
    /\*\*`(\w+)`\*\*[^\n]*\n\n\| Column[^\n]*\n\|[-|]+\n((?:\|[^\n]*\n)+)/g,
  )) {
    tables[name as string] = (body as string)
      .trim()
      .split("\n")
      .flatMap((row) => ticks(row.split("|")[1] as string));
  }
  return tables;
}

/** Tables 02 describes in a sentence. Kept by hand; `docMentions` below catches a renamed column. */
const SENTENCE_TABLES: Record<string, string[]> = {
  passwords: ["person_id", "org_id", "hash", "updated_at"],
  webauthn_challenges: ["id", "org_id", "challenge", "kind", "person_id", "expires_at"],
  guest_links: ["guest_id", "org_id", "share_link_id", "name", "created_at", "expires_at"],
  reset_links: [
    "id",
    "org_id",
    "person_id",
    "token_hash",
    "created_by",
    "created_at",
    "expires_at",
    "used_at",
  ],
  projects: ["id", "org_id", "slug", "name", "repo", "created_at", "updated_at"],
  artifact_access: ["artifact_id", "org_id", "person_id", "permission", "granted_by", "created_at"],
  share_links: [
    "id",
    "org_id",
    "artifact_id",
    "token_hash",
    "permission",
    "created_by",
    "created_at",
    "expires_at",
    "revoked_at",
  ],
  blobs: ["org_id", "hash", "size", "verified_at"],
  pages: ["id", "org_id", "version_id", "page_key", "kind", "title", "group", "position", "meta"],
  blocks: ["id", "org_id", "version_id", "page_key", "block_key", "content_hash", "text"],
  comments: [
    "id",
    "thread_id",
    "org_id",
    "author_person_id",
    "author_guest_id",
    "author_name",
    "agent",
    "body",
    "version",
    "marks_fixed",
    "created_at",
    "edited_at",
  ],
  decisions: ["id", "org_id", "artifact_id", "version", "person_id", "kind", "note", "created_at"],
  views: ["person_id", "org_id", "artifact_id", "last_seen_version", "last_seen_at", "positions"],
  guest_views: ["guest_id", "org_id", "artifact_id", "last_seen_version", "last_seen_at", "positions"],
  activity: [
    "id",
    "org_id",
    "artifact_id",
    "project_id",
    "actor_person_id",
    "actor_guest_id",
    "agent",
    "kind",
    "payload",
    "created_at",
  ],
  tombstones: ["id", "org_id", "kind", "project_slug", "slug", "title", "version", "deleted_by", "purged_at"],
};

function docSentence(table: string): string {
  const start = doc.indexOf(`**\`${table}\`**`);
  return doc.slice(doc.lastIndexOf("\n", start), doc.indexOf("\n", start));
}

describe("the database matches 02-data-model.md", () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    database = await createDatabase();
    await runMigrations(database.url);
    sql = postgres(database.url, { max: 1 });
  });
  afterAll(async () => {
    await sql.end();
    await database.drop();
  });

  const columnsOf = async (table: string) => {
    const rows = await sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = ${table}`;
    return rows.map((row) => row.column_name as string).sort();
  };

  test("every enum and value", async () => {
    const rows = await sql`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname`;
    const actual = Object.fromEntries(rows.map((row) => [row.typname, row.labels]));
    expect(actual).toEqual(docEnums());
    expect(Object.keys(actual)).toHaveLength(11);
  });

  test("every table", async () => {
    const rows = await sql`
      select table_name from information_schema.tables where table_schema = 'public'`;
    const named = [...doc.matchAll(/\*\*`(\w+)`\*\*/g)]
      .map((match) => match[1] as string)
      .filter((name) => !phase2.has(name) && name !== "releases");
    expect(rows.map((row) => row.table_name).sort()).toEqual([...new Set(named)].sort());
  });

  test("columns of tables written as tables", async () => {
    const tables = docPipeTables();
    expect(Object.keys(tables).sort()).toEqual(
      [
        "artifacts",
        "device_codes",
        "frames",
        "guests",
        "invites",
        "org",
        "passkeys",
        "people",
        "sessions",
        "threads",
        "tokens",
        "versions",
      ].sort(),
    );
    for (const [table, columns] of Object.entries(tables)) {
      expect({ table, columns: await columnsOf(table) }).toEqual({ table, columns: [...columns].sort() });
    }
  });

  test("columns of tables written as sentences", async () => {
    for (const [table, columns] of Object.entries(SENTENCE_TABLES)) {
      expect({ table, columns: await columnsOf(table) }).toEqual({ table, columns: [...columns].sort() });
      const sentence = docSentence(table);
      const missing = columns.filter((column) => !sentence.includes(column) && column !== "id");
      expect({ table, missing }).toEqual({ table, missing: [] });
    }
  });

  test("every table but org has org_id, not null, referencing org", async () => {
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name <> 'org'`;
    const columns = await sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id' and is_nullable = 'NO'`;
    const references = await sql`
      select conrelid::regclass::text as table_name from pg_constraint
      where contype = 'f' and confrelid = 'org'::regclass
        and conkey = array[(select attnum from pg_attribute where attrelid = conrelid and attname = 'org_id')]`;
    const names = (rows: postgres.Row[]) => rows.map((row) => row.table_name as string).sort();
    expect(tables).toHaveLength(27);
    expect(names(columns)).toEqual(names(tables));
    expect(names(references)).toEqual(names(tables));
  });

  test("org.pseudonym_key is bytea not null", async () => {
    const [column] = await sql`
      select data_type, is_nullable from information_schema.columns
      where table_name = 'org' and column_name = 'pseudonym_key'`;
    expect(column).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
  });

  test("the indexes 02 names", async () => {
    const rows = await sql`select indexdef from pg_indexes where schemaname = 'public'`;
    const defs = rows.map((row) => row.indexdef as string);
    const has = (pattern: RegExp) => expect(defs.filter((def) => pattern.test(def))).toHaveLength(1);
    has(/UNIQUE INDEX .* ON public\.people .*\(org_id, lower\(.*email.*\)\) WHERE \(removed_at IS NULL\)/);
    has(/UNIQUE INDEX .* ON public\.artifacts .*\(project_id, slug\)/);
    has(/INDEX .* ON public\.artifacts .*\(org_id, updated_at DESC.*\) WHERE \(deleted_at IS NULL\)/);
    has(/INDEX .* ON public\.artifacts .*\(purge_after\) WHERE \(deleted_at IS NOT NULL\)/);
    has(/INDEX .* ON public\.activity .*\(org_id, created_at DESC/);
    has(/UNIQUE INDEX .* ON public\.versions .*\(artifact_id, n\)/);
    has(/UNIQUE INDEX .* ON public\.threads .*\(artifact_id, n\)/);
  });

  test("schema package enums agree with the database", () => {
    const enums = docEnums();
    expect([...Permission.options]).toEqual(enums.permission as typeof Permission.options);
    expect([...Role.options]).toEqual(enums.role as typeof Role.options);
  });

  describe("awkward types round trip through the driver", () => {
    const orgId = Bun.randomUUIDv7();
    const personId = Bun.randomUUIDv7();
    const key = new Uint8Array(32).map((_, i) => i * 7);

    test("bytea and jsonb", async () => {
      const { db, close } = connect(database.url);
      await db.insert(org).values({
        id: orgId,
        name: "Mochahub",
        homeDomain: "art.example.org",
        settings: DEFAULT_ORG_SETTINGS,
        pseudonymKey: key,
      });
      const row = await findOrg(db);
      await close();
      expect(new Uint8Array(row?.pseudonymKey as Uint8Array)).toEqual(key);
      expect(row?.settings).toEqual(DEFAULT_ORG_SETTINGS);
    });

    test("citext: the unique index ignores case, and removing someone frees the address", async () => {
      const { db, close } = connect(database.url);
      const person = { orgId, name: "Sam", role: "member" as const };
      await db.insert(people).values({ id: personId, email: "Sam@Example.com", ...person });
      const [found] = await db.select().from(people).where(eq(people.email, "sam@example.COM"));
      expect(found?.id).toBe(personId);
      expect(found?.email).toBe("Sam@Example.com");

      const again = db.insert(people).values({ id: Bun.randomUUIDv7(), email: "SAM@example.com", ...person });
      await expect(again.execute()).rejects.toThrow();

      const other = Bun.randomUUIDv7();
      await db
        .insert(people)
        .values({ id: other, email: "gone@example.com", ...person, removedAt: new Date() });
      await db.insert(people).values({ id: Bun.randomUUIDv7(), email: "GONE@example.com", ...person });
      await close();
    });

    test("text[] and uuid[]", async () => {
      const { db, close } = connect(database.url);
      const projectIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      const id = Bun.randomUUIDv7();
      await db.insert(tokens).values({
        id,
        orgId,
        kind: "org",
        name: "CI",
        tokenHash: "hash",
        scopes: ["publish", "read"],
        projectIds,
        createdBy: personId,
      });
      await db.insert(passkeys).values({
        id: Bun.randomUUIDv7(),
        orgId,
        personId,
        credentialId: new Uint8Array([1, 2, 3]),
        publicKey: new Uint8Array([255, 0, 128]),
        counter: 2 ** 40,
        transports: ["internal", "hybrid"],
        rpId: "art.example.org",
      });
      const [token] = await db.select().from(tokens).where(eq(tokens.id, id));
      const [passkey] = await db.select().from(passkeys).where(eq(passkeys.personId, personId));
      await close();
      expect(token?.scopes).toEqual(["publish", "read"]);
      expect(token?.projectIds).toEqual(projectIds);
      expect(passkey?.transports).toEqual(["internal", "hybrid"]);
      expect(passkey?.counter).toBe(2 ** 40);
      expect(new Uint8Array(passkey?.publicKey as Uint8Array)).toEqual(new Uint8Array([255, 0, 128]));
    });

    test("a thread has exactly one author", async () => {
      const { db, close } = connect(database.url);
      const projectId = Bun.randomUUIDv7();
      const artifactId = Bun.randomUUIDv7();
      await db.insert(projects).values({ id: projectId, orgId, slug: "camerabuddy", name: "Camera Buddy" });
      await db.insert(artifacts).values({
        id: artifactId,
        orgId,
        projectId,
        slug: "roadmap",
        title: "Roadmap",
        visibility: "org",
        publisherId: personId,
      });
      const thread = { orgId, artifactId, pageKey: "plan", createdVersion: 1, authorName: "Sam" };
      await expect(
        db
          .insert(threads)
          .values({ id: Bun.randomUUIDv7(), n: 1, ...thread })
          .execute(),
      ).rejects.toThrow();
      await db.insert(threads).values({ id: Bun.randomUUIDv7(), n: 1, authorPersonId: personId, ...thread });
      await close();
    });
  });
});
