import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate.ts";
import { createDatabase } from "./helpers.ts";

/** Exercise the actual generated add-only migrations against a populated Phase 2 schema. */
test("boards migration preserves a Phase 2 draft, frame pixels and anchor", async () => {
  const database = await createDatabase();
  const sql = postgres(database.url, { max: 1, onnotice: () => {} });
  const scratchRoot = join(import.meta.dir, "../../../.artifacts");
  mkdirSync(scratchRoot, { recursive: true });
  const previous = mkdtempSync(join(scratchRoot, "p3-migration-"));
  try {
    const source = join(import.meta.dir, "../drizzle");
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const entries = journal.entries.filter((entry) => entry.idx <= 18);
    mkdirSync(join(previous, "meta"));
    writeFileSync(join(previous, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) cpSync(join(source, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`));
    await migrate(drizzle({ client: sql }), { migrationsFolder: previous });

    const org = crypto.randomUUID();
    const person = crypto.randomUUID();
    const project = crypto.randomUUID();
    const artifact = crypto.randomUUID();
    const version = crypto.randomUUID();
    const snapshot = Buffer.from([0, 1, 2, 3]);
    const hash = "a".repeat(64);
    const renders = { "1x": hash, "2x": hash, "3x": hash, thumb: hash };
    const anchor = { type: "frame", frameKey: "welcome", x: 0.5, y: 0.25 };
    await sql`insert into org (id,name,home_domain,settings,pseudonym_key) values
      (${org},'Migration fixture','viewer.test','{}',${Buffer.alloc(32)})`;
    await sql`insert into people (id,org_id,email,name,role) values
      (${person},${org},'author@example.test','Author','member')`;
    await sql`insert into projects (id,org_id,slug,name) values (${project},${org},'wiki','Wiki')`;
    await sql`insert into artifacts (id,org_id,project_id,slug,title,visibility,publisher_id) values
      (${artifact},${org},${project},'board','Board','org',${person})`;
    await sql`insert into versions (id,org_id,artifact_id,n,files,published_by) values
      (${version},${org},${artifact},1,'{}',${person})`;
    await sql`insert into edit_docs
      (artifact_id,org_id,page_key,base_version,version,seq,checkpoint_seq,snapshot_seq,snapshot)
      values (${artifact},${org},'board',1,1,7,5,6,${snapshot})`;
    await sql`insert into edit_presence
      (artifact_id,connection_id,org_id,person_id,mode,blocks,replica,seen_at)
      values (${artifact},'old-client',${org},${person},'write',array['~k3j9x0a1b2'],'old',now())`;
    await sql`insert into frames
      (id,org_id,version_id,page_key,board_key,frame_key,x,y,w,h,content_hash,renders)
      values (${crypto.randomUUID()},${org},${version},'board','onboarding','welcome',10,20,390,844,${hash},${JSON.stringify(renders)}::jsonb)`;
    await sql`insert into threads
      (id,artifact_id,org_id,n,page_key,anchor,created_version,author_person_id,author_name)
      values (${crypto.randomUUID()},${artifact},${org},1,'board',${JSON.stringify(anchor)}::jsonb,1,${person},'Author')`;

    await runMigrations(database.url);
    const [draft] = await sql`select kind,seq,checkpoint_seq,snapshot_seq,snapshot from edit_docs`;
    expect(draft).toMatchObject({ kind: "article", seq: "7", checkpoint_seq: "5", snapshot_seq: "6" });
    expect(Buffer.from(draft?.snapshot)).toEqual(snapshot);
    const [presence] = await sql`select blocks,objects from edit_presence`;
    expect(presence).toEqual({ blocks: ["~k3j9x0a1b2"], objects: [] });
    const [frame] = await sql`select x,y,w,h,content_hash,renders from frames`;
    expect(
      JSON.parse(
        JSON.stringify({
          ...frame,
          renders: typeof frame?.renders === "string" ? JSON.parse(frame.renders) : frame?.renders,
        }),
      ),
    ).toEqual({ x: 10, y: 20, w: 390, h: 844, content_hash: hash, renders });
    const [thread] = await sql`select anchor from threads`;
    expect(typeof thread?.anchor === "string" ? JSON.parse(thread.anchor) : thread?.anchor).toEqual(anchor);
    for (const table of [
      "board_versions",
      "board_assets",
      "board_captures",
      "board_suggestions",
      "board_requests",
    ]) {
      const [row] = await sql.unsafe(`select count(*)::int as n from ${table}`);
      expect(row?.n).toBe(0);
    }
  } finally {
    await sql.end();
    await database.drop();
    rmSync(previous, { recursive: true, force: true });
  }
}, 30_000);
