import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { artifacts, people, versions } from "../../src/db/schema.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { file, publish } from "../publish-helper.ts";

describe("the content host", () => {
  let t: TestServer;
  let cookie: string;
  let ownerToken: string;
  let id: string;
  beforeAll(async () => {
    t = await startTestServer();
    const owner = await claim(t);
    ownerToken = owner.token;
    await publish(t, owner.token);
    cookie = await signIn(t, OWNER.email, OWNER.password);
    id = (await t.server.db.select().from(artifacts))[0]?.id as string;
  });
  afterAll(() => t.stop());

  const mint = async (version = 1) => {
    const response = await t.api(`/api/artifacts/${id}/content-token`, {
      method: "POST",
      cookie,
      json: { version },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { base: string }).base;
  };
  const get = (base: string, path: string, dest: string | null = "iframe", host = "content.test") =>
    fetch(`http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}${path}`, {
      headers: { Host: host, ...(dest ? { "Sec-Fetch-Dest": dest } : {}) },
    });

  test("serves a bundle file with every header in 03", async () => {
    const base = await mint();
    expect(base).toMatch(/^http:\/\/content\.test\/t\/.+\/v1\/$/);
    const response = await get(base, "index.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = response.headers.get("content-security-policy") as string;
    expect(csp).toContain("default-src http://content.test");
    expect(csp).toContain("frame-ancestors http://viewer.test https://art.example.org");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
  });

  test("answers byte ranges, which Safari needs for media", async () => {
    const base = await mint();
    const url = `http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}index.html`;
    const headers = { Host: "content.test", "Sec-Fetch-Dest": "video" };
    const full = await (await fetch(url, { headers })).text();
    const part = await fetch(url, { headers: { ...headers, Range: "bytes=0-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-3/${full.length}`);
    expect(await part.text()).toBe(full.slice(0, 4));
    const tail = await fetch(url, { headers: { ...headers, Range: "bytes=-2" } });
    expect(await tail.text()).toBe(full.slice(-2));
    expect((await fetch(url, { headers: { ...headers, Range: "bytes=999999-" } })).status).toBe(416);
  });

  test("a big file is read from the bucket in pieces, never whole", async () => {
    const piece = 8 * 1024 * 1024;
    const body = `${"0123456789abcdef".repeat(piece / 16 + 1000)}`; // A little over 8 MB.
    const movie = file("clip.bin", body, "video/mp4");
    expect((await publish(t, ownerToken, { slug: "big", extra: [movie] })).status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "big"));
    const minted = await t.api(`/api/artifacts/${row?.id}/content-token`, {
      method: "POST",
      cookie,
      json: { version: 1 },
    });
    const { base } = (await minted.json()) as { base: string };
    const url = `http://127.0.0.1:${t.server.ports.content}${new URL(base).pathname}clip.bin`;
    const headers = { Host: "content.test", "Sec-Fetch-Dest": "video" };

    // "From here to the end" is what browsers ask first; the answer may be shorter than the file.
    const open = await fetch(url, { headers: { ...headers, Range: "bytes=0-" } });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 0-${piece - 1}/${body.length}`);
    expect((await open.arrayBuffer()).byteLength).toBe(piece);

    const tail = await fetch(url, { headers: { ...headers, Range: `bytes=${body.length - 5}-` } });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe(body.slice(-5));
    expect((await fetch(url, { headers: { ...headers, Range: `bytes=${body.length}-` } })).status).toBe(416);
  });

  test("refuses a top-level page, and a request with no Sec-Fetch-Dest", async () => {
    const base = await mint();
    expect((await get(base, "index.html", "document")).status).toBe(403);
    expect((await get(base, "index.html", null)).status).toBe(403);
    expect((await get(base, "index.html", "style")).status).toBe(200);
    expect((await get(base, "index.html", "video")).status).toBe(200);
  });

  test("refuses other hosts, other versions and unknown paths", async () => {
    const base = await mint();
    expect((await get(base, "index.html", "iframe", "viewer.test")).status).toBe(421);
    expect((await get(base.replace("/v1/", "/v2/"), "index.html")).status).toBe(403);
    expect((await get(base, "nothing.html")).status).toBe(404);
    expect((await get(base, "constructor")).status).toBe(404);
    const [head] = base.split("/t/");
    expect((await get(`${head}/t/forged.token/v1/`, "index.html")).status).toBe(403);
  });

  test("an expired token stops working", async () => {
    const base = await mint();
    t.clock.advance(2 * 3600_000 + 1000);
    expect((await get(base, "index.html")).status).toBe(403);
    cookie = await signIn(t, OWNER.email, OWNER.password);
  });

  test("access is re-checked: deleting, removing a version or a person stops open frames in seconds", async () => {
    const base = await mint();
    expect((await get(base, "index.html")).status).toBe(200);

    await t.server.db.update(artifacts).set({ deletedAt: t.clock.now() }).where(eq(artifacts.id, id));
    t.clock.advance(5001);
    expect((await get(base, "index.html")).status).toBe(404);
    await t.server.db.update(artifacts).set({ deletedAt: null }).where(eq(artifacts.id, id));
    t.clock.advance(5001);
    expect((await get(base, "index.html")).status).toBe(200);

    await t.server.db.update(versions).set({ deletedAt: t.clock.now() }).where(eq(versions.artifactId, id));
    t.clock.advance(5001);
    expect((await get(base, "index.html")).status).toBe(404);
    await t.server.db.update(versions).set({ deletedAt: null }).where(eq(versions.artifactId, id));
    t.clock.advance(5001);

    await t.server.db.update(people).set({ removedAt: t.clock.now() });
    t.clock.advance(5001);
    expect((await get(base, "index.html")).status).toBe(404);
    await t.server.db.update(people).set({ removedAt: null });
  });

  test("minting needs a browser caller and a live version", async () => {
    expect(
      (await t.api(`/api/artifacts/${id}/content-token`, { method: "POST", json: { version: 1 } })).status,
    ).toBe(401);
    expect(
      (await t.api(`/api/artifacts/${id}/content-token`, { method: "POST", cookie, json: { version: 99 } }))
        .status,
    ).toBe(404);
  });
});
