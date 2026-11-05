import { createHash } from "node:crypto";
import { PublishPrepared } from "@artifacts/schema";
import { randomSecret, sha256 } from "../src/auth/secrets.ts";
import { people, sessions, tokens } from "../src/db/schema.ts";
import type { TestServer } from "./helpers.ts";

export const hash = (body: string) => createHash("sha256").update(body).digest("hex");
export const file = (path: string, body: string, type = "text/html") => ({
  path,
  body,
  sha256: hash(body),
  size: Buffer.byteLength(body),
  type,
});

/** A minimal publish, the way the CLI does it: prepare, upload what's missing, commit. */
export async function publish(
  t: TestServer,
  bearer: string,
  options: {
    project?: string;
    slug?: string;
    files?: ReturnType<typeof file>[];
    frameHash?: string;
    visibility?: "me" | "org";
    extra?: ReturnType<typeof file>[];
    tamper?: string;
    renderBytes?: Uint8Array;
    frameKey?: string;
    title?: string;
    backend?: string;
    agent?: string;
    summary?: string | null;
    tags?: string[];
    blocks?: { key: string; text: string }[];
    frameTitle?: string;
    message?: string;
    notes?: Record<string, string>;
    repo?: string;
  } = {},
) {
  const { project = "camerabuddy", slug = "roadmap", frameHash = hash("frame"), visibility } = options;
  const page = file("index.html", `<h1>${frameHash}</h1>`);
  const article = file(
    "__articles/plan.html",
    '<p data-block="intro/p1" onclick="x()">Hello<script>1</script></p>',
  );
  const render = options.renderBytes
    ? {
        ...file("__renders/a.webp", "", "image/webp"),
        body: options.renderBytes as unknown as string,
        sha256: createHash("sha256").update(options.renderBytes).digest("hex"),
        size: options.renderBytes.length,
      }
    : file("__renders/a.webp", `render-${frameHash}`, "image/webp");
  const module = options.backend ? file("__backend.js", options.backend, "text/javascript") : null;
  const files = [
    ...(options.files ?? [page, article, render]),
    ...(options.extra ?? []),
    ...(module ? [module] : []),
  ];
  const prepared = await t.api("/api/publish/prepare", {
    method: "POST",
    bearer,
    json: {
      project,
      slug,
      title: options.title ?? "Roadmap",
      visibility,
      repo: options.repo,
      files: files.map(({ body: _, ...rest }) => rest),
    },
  });
  if (prepared.status !== 200) return prepared;
  const ready = PublishPrepared.parse(await prepared.json());
  for (const missing of ready.missing) {
    const source = files.find((f) => f.sha256 === missing.sha256);
    const upload = await fetch(missing.url, {
      method: "PUT",
      headers: missing.headers,
      body: options.tamper === missing.sha256 ? "x".repeat(source?.size ?? 0) : source?.body,
    });
    if (!upload.ok && upload.status !== 412)
      throw new Error(`upload ${upload.status}: ${await upload.text()}`);
  }
  const bundle = Object.fromEntries(
    files
      .filter((f) => !f.path.startsWith("__renders/"))
      .map((f) => [f.path, { hash: f.sha256, size: f.size, type: f.type }]),
  );
  return t.api("/api/publish/commit", {
    method: "POST",
    bearer,
    json: {
      uploadId: ready.uploadId,
      message: options.message ?? "First",
      agent: options.agent,
      summary: options.summary,
      tags: options.tags,
      notes: options.notes,
      backendHash: module?.sha256 ?? null,
      files: bundle,
      pages: [
        {
          key: "plan",
          kind: "article",
          title: "Plan",
          group: null,
          position: 0,
          meta: { htmlHash: article.sha256, outline: [], readingMinutes: 1 },
        },
        { key: "mocks", kind: "canvas", title: "Mocks", group: null, position: 1, meta: { boards: [] } },
      ],
      frames: [
        {
          pageKey: "mocks",
          boardKey: "main",
          frameKey: options.frameKey ?? "live-view",
          title: options.frameTitle ?? "Live view",
          device: "iphone",
          x: 0,
          y: 0,
          w: 393,
          h: 852,
          contentHash: frameHash,
          renders: { "1x": render.sha256, "2x": render.sha256, "3x": render.sha256, thumb: render.sha256 },
          livePath: "index.html",
        },
      ],
      blocks: (options.blocks ?? [{ key: "intro/p1", text: "Hello" }]).map((block) => ({
        pageKey: "plan",
        blockKey: block.key,
        contentHash: hash(block.text),
        text: block.text,
      })),
    },
  });
}

let people_n = 0;
/** A person with a CLI token, without going through invites (M6). */
export async function makePerson(
  t: TestServer,
  orgId: string,
  role: "member" | "reviewer" | "outside" | "admin",
) {
  const id = Bun.randomUUIDv7();
  people_n += 1;
  await t.server.db
    .insert(people)
    .values({ id, orgId, email: `p${people_n}@example.com`, name: `P${people_n}`, role });
  const secret = `art_test${id}`;
  await t.server.db.insert(tokens).values({
    id: Bun.randomUUIDv7(),
    orgId,
    kind: "cli",
    personId: id,
    name: "test",
    tokenHash: sha256(secret),
    scopes: ["publish", "comment", "read", "manage", "data"],
    createdBy: id,
  });
  return secret;
}

/** A person with a CLI token and a browser session, for routes only a session can use. */
export async function makeAccount(
  t: TestServer,
  orgId: string,
  role: "member" | "reviewer" | "outside" | "admin",
) {
  const token = await makePerson(t, orgId, role);
  const id = token.slice("art_test".length);
  const secret = randomSecret();
  const now = t.clock.now();
  await t.server.db.insert(sessions).values({
    id: Bun.randomUUIDv7(),
    orgId,
    tokenHash: sha256(secret),
    personId: id,
    domain: "viewer.test",
    authAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 3600_000),
  });
  return {
    id,
    token,
    cookie: `art_session=${secret}`,
    email: `p${people_n}@example.com`,
    name: `P${people_n}`,
  };
}
