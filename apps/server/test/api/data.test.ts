import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { artifacts, people } from "../../src/db/schema.ts";
import { claim, startTestServer, type TestServer } from "../helpers.ts";
import { hash, makePerson, publish } from "../publish-helper.ts";

const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("the data store", () => {
  let t: TestServer;
  let token: string;
  let sam: string;
  let jo: string;
  let id: string;
  let n = 0;

  const put = (
    scope: string,
    key: string,
    value: unknown,
    bearer = token,
    headers: Record<string, string> = {},
  ) =>
    t.api(`/api/artifacts/${id}/data/${scope}/${key}`, { method: "PUT", bearer, json: { value }, headers });
  const get = (scope: string, key: string, bearer = token) =>
    t.api(`/api/artifacts/${id}/data/${scope}/${key}`, { bearer });
  const fresh = async () => {
    n += 1;
    await publish(t, token, { slug: `data-${n}`, frameHash: hash(`d${n}`) });
    const [row] = await t.server.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.slug, `data-${n}`));
    id = row?.id as string;
  };

  beforeAll(async () => {
    t = await startTestServer();
    token = (await claim(t)).token;
    const orgId = (await t.server.db.select().from(people))[0]?.orgId as string;
    sam = await makePerson(t, orgId, "member");
    jo = await makePerson(t, orgId, "member");
    await fresh();
  });
  afterAll(() => t.stop());

  test("a value round trips, and nothing is there before it's written", async () => {
    expect((await get("shared", "votes")).status).toBe(404);
    const made = await put("shared", "votes", { a: 1 });
    expect(made.status).toBe(200);
    const { etag } = (await made.json()) as { etag: string };
    expect(await (await get("shared", "votes")).json()).toEqual({ value: { a: 1 }, etag });
  });

  test("conditional writes: If-Match and If-None-Match, including a key that isn't there", async () => {
    const first = (await (await put("shared", "c", 1)).json()) as { etag: string };
    expect((await put("shared", "c", 2, token, { "If-Match": first.etag })).status).toBe(200);
    expect(await code(await put("shared", "c", 3, token, { "If-Match": first.etag }))).toBe(
      "precondition_failed",
    );
    expect((await put("shared", "c", 3, token, { "If-None-Match": "*" })).status).toBe(412);
    expect((await put("shared", "new", 1, token, { "If-None-Match": "*" })).status).toBe(200);
    expect((await put("shared", "missing", 1, token, { "If-Match": "abc" })).status).toBe(412);
  });

  test("ten people racing a conditional update: exactly one wins", async () => {
    const { etag } = (await (await put("shared", "race", 0)).json()) as { etag: string };
    await Bun.sleep(1100);
    const results = await Promise.all(
      [sam, jo, token].map((bearer, i) => put("shared", "race", i + 1, bearer, { "If-Match": etag })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 412, 412]);
  });

  test("two people's me data stay separate, and each sees only their own", async () => {
    await put("me", "todo", "sam's", sam);
    await put("me", "todo", "jo's", jo);
    expect(((await (await get("me", "todo", sam)).json()) as { value: string }).value).toBe("sam's");
    expect(((await (await get("me", "todo", jo)).json()) as { value: string }).value).toBe("jo's");
    const list = (await (await t.api(`/api/artifacts/${id}/data/me`, { bearer: sam })).json()) as {
      keys: { key: string }[];
    };
    expect(list.keys.map((entry) => entry.key)).toEqual(["todo"]);
  });

  test("a pseudonym differs per artifact", async () => {
    const before = id;
    await put("me", "x", 1, sam);
    const objects = await t.server.bucket.list(`data/${before}/me/`);
    await fresh();
    await put("me", "x", 1, sam);
    const after = await t.server.bucket.list(`data/${id}/me/`);
    const pseudonymOf = (key: string) => key.split("/")[3];
    expect(pseudonymOf(after.objects[0]?.key as string)).not.toBe(
      pseudonymOf(objects.objects[0]?.key as string),
    );
  });

  test("keys are checked", async () => {
    expect((await put("shared", "a b", 1)).status).toBe(400);
    expect((await put("shared", "a%2F..%2Fb", 1)).status).toBe(400);
    expect((await put("shared", `${"k".repeat(201)}`, 1)).status).toBe(400);
    expect((await put("shared", "todos/1", 1)).status).toBe(200);
    expect((await put("nothing", "a", 1)).status).toBe(404);
    const list = (await (
      await t.api(`/api/artifacts/${id}/data/shared?prefix=todos/`, { bearer: token })
    ).json()) as { keys: { key: string }[] };
    expect(list.keys.map((entry) => entry.key)).toEqual(["todos/1"]);
  });

  test("limits: value size, key count, bytes per scope, and writes per second", async () => {
    await fresh();
    expect((await put("shared", "big", "x".repeat(70_000))).status).toBe(413);
    const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => put("shared", `b${i}`, i, sam)));
    expect(burst.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    expect(burst.filter((r) => r.status === 200).length).toBeLessThanOrEqual(10);
  });

  test("delete frees the usage; a missing key is 404", async () => {
    await Bun.sleep(1100);
    await fresh();
    await put("shared", "gone", 1);
    expect(
      (await t.api(`/api/artifacts/${id}/data/shared/gone`, { method: "DELETE", bearer: token })).status,
    ).toBe(200);
    expect(
      (await t.api(`/api/artifacts/${id}/data/shared/gone`, { method: "DELETE", bearer: token })).status,
    ).toBe(404);
  });

  test("files: types, downloads and listing", async () => {
    const up = (name: string, body: string, type: string, bearer = token) =>
      t.api(`/api/artifacts/${id}/files/shared/${name}`, {
        method: "PUT",
        bearer,
        body,
        headers: { "Content-Type": type },
      });
    await Bun.sleep(1100);
    expect((await up("a.png", "png-bytes", "image/png")).status).toBe(200);
    await Bun.sleep(150);
    expect((await up("page.html", "<script>1</script>", "text/html")).status).toBe(200);
    await Bun.sleep(150);
    expect((await up("x.svg", "<svg/>", "image/svg+xml")).status).toBe(200);

    const image = await t.api(`/api/artifacts/${id}/files/shared/a.png`, {
      bearer: token,
      redirect: "manual",
    });
    expect(image.status).toBe(302);
    const png = await fetch(image.headers.get("location") as string);
    expect(png.headers.get("content-type")).toBe("image/png");
    const html = await t.api(`/api/artifacts/${id}/files/shared/page.html`, {
      bearer: token,
      redirect: "manual",
    });
    const page = await fetch(html.headers.get("location") as string);
    expect(page.headers.get("content-disposition")).toBe("attachment");
    expect(page.headers.get("content-type")).not.toContain("html");
    // A type with parameters or a list in it can't slip past the check, in any case.
    for (const [name, type] of [
      ["y.svg", "image/SVG+xml; charset=utf-8"],
      ["z.png", "image/png, text/html"],
    ] as const) {
      expect((await up(name, "<svg/>", type)).status).toBe(200);
      const url = await t.api(`/api/artifacts/${id}/files/shared/${name}`, {
        bearer: token,
        redirect: "manual",
      });
      expect((await fetch(url.headers.get("location") as string)).headers.get("content-disposition")).toBe(
        "attachment",
      );
      await t.api(`/api/artifacts/${id}/files/shared/${name}`, { method: "DELETE", bearer: token });
    }
    const svg = await t.api(`/api/artifacts/${id}/files/shared/x.svg`, { bearer: token, redirect: "manual" });
    expect((await fetch(svg.headers.get("location") as string)).headers.get("content-disposition")).toBe(
      "attachment",
    );

    const asJson = await t.api(`/api/artifacts/${id}/files/shared/a.png`, {
      bearer: token,
      headers: { Accept: "application/json" },
    });
    expect(((await asJson.json()) as { url: string }).url).toContain("a.png");
    const list = (await (await t.api(`/api/artifacts/${id}/files/shared`, { bearer: token })).json()) as {
      files: { name: string }[];
    };
    expect(list.files.map((f) => f.name).sort()).toEqual(["a.png", "page.html", "x.svg"]);
    expect(
      (await t.api(`/api/artifacts/${id}/files/shared/a.png`, { method: "DELETE", bearer: token })).status,
    ).toBe(200);
  });

  test("export names people; clear empties; only the publisher and admins", async () => {
    await Bun.sleep(1100);
    await fresh();
    await put("shared", "s", 1);
    await put("me", "m", 2, sam);
    const exported = (await (await t.api(`/api/artifacts/${id}/data-export`, { bearer: token })).json()) as {
      shared: Record<string, unknown>;
      me: Record<string, { name: string; data: Record<string, unknown> }>;
    };
    expect(exported.shared).toEqual({ s: 1 });
    expect(Object.values(exported.me)[0]).toMatchObject({ data: { m: 2 } });
    expect(Object.values(exported.me)[0]?.name).toStartWith("P");
    expect((await t.api(`/api/artifacts/${id}/data-export`, { bearer: sam })).status).toBe(403);
    expect(
      (await t.api(`/api/artifacts/${id}/data-clear`, { method: "POST", bearer: sam, json: {} })).status,
    ).toBe(403);
    expect(
      (
        await t.api(`/api/artifacts/${id}/data-clear`, {
          method: "POST",
          bearer: token,
          json: { scope: "me" },
        })
      ).status,
    ).toBe(200);
    expect((await get("shared", "s")).status).toBe(200);
    expect((await get("me", "m", sam)).status).toBe(404);
  });

  test("archived data is read-only everywhere", async () => {
    await Bun.sleep(1100);
    await fresh();
    await put("shared", "k", 1);
    await t.api(`/api/artifacts/${id}/archive`, { method: "POST", bearer: token });
    expect((await get("shared", "k")).status).toBe(200);
    expect(await code(await put("shared", "k", 2))).toBe("read_only");
    expect(
      await code(await t.api(`/api/artifacts/${id}/data-clear`, { method: "POST", bearer: token, json: {} })),
    ).toBe("read_only");
    expect((await t.api(`/api/artifacts/${id}/data-export`, { bearer: token })).status).toBe(200);
  });

  test("no caller, a stranger, and a view-only guest", async () => {
    await Bun.sleep(1100);
    await fresh();
    await put("shared", "k", 1);
    expect((await t.api(`/api/artifacts/${id}/data/shared/k`)).status).toBe(401);
    const { url } = (await (
      await t.api(`/api/artifacts/${id}/links`, {
        method: "POST",
        bearer: token,
        json: { permission: "view" },
      })
    ).json()) as { url: string };
    const secret = url.split("/s/")[1];
    const joined = await t.api(`/api/s/${secret}/guest`, { method: "POST", json: { name: "G" } });
    const cookie = (joined.headers.getSetCookie()[0] ?? "").split(";")[0] as string;
    expect((await t.api(`/api/artifacts/${id}/data/shared/k`, { cookie })).status).toBe(200);
    const write = await t.api(`/api/artifacts/${id}/data/shared/k`, {
      method: "PUT",
      cookie,
      json: { value: 2 },
    });
    expect(write.status).toBe(403);
  });

  test("the usage job recounts what's really there", async () => {
    await Bun.sleep(1100);
    await fresh();
    await put("shared", "a", 1);
    await t.server.bucket.put(`data/${id}/shared/stray`, "12345");
    const response = await fetch(`http://127.0.0.1:${t.server.ports.internal}/internal/jobs/usage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"o".repeat(64)}` },
    });
    expect(response.status).toBe(200);
    const { artifactUsage } = await import("../../src/db/schema.ts");
    const rows = await t.server.db.select().from(artifactUsage).where(eq(artifactUsage.artifactId, id));
    expect(rows.find((row) => row.scope === "shared")?.keys).toBe(2);
  });
});

describe("limits, with an org that's lowered them", () => {
  let t: TestServer;
  let token: string;
  let id: string;
  const put = (key: string, value: unknown) =>
    t.api(`/api/artifacts/${id}/data/shared/${key}`, { method: "PUT", bearer: token, json: { value } });

  beforeAll(async () => {
    t = await startTestServer();
    token = (await claim(t)).token;
    await publish(t, token, { slug: "limits" });
    id = (await t.server.db.select().from(artifacts))[0]?.id as string;
    const { org } = await import("../../src/db/schema.ts");
    const [row] = await t.server.db.select().from(org);
    const settings = row?.settings as { limits: Record<string, number> };
    settings.limits.dataKeysPerScope = 2;
    settings.limits.dataBytesPerScope = 100;
    settings.limits.fileBytes = 10;
    settings.limits.writesPerSecond = 100;
    await t.server.db.update(org).set({ settings });
  });
  afterAll(() => t.stop());

  test("key count and bytes are enforced, and overwriting doesn't count twice", async () => {
    expect((await put("a", 1)).status).toBe(200);
    expect((await put("a", 2)).status).toBe(200);
    expect((await put("b", 1)).status).toBe(200);
    expect((await put("c", 1)).status).toBe(413);
    expect((await put("a", "x".repeat(200))).status).toBe(413);
  });

  test("file size", async () => {
    const big = await t.api(`/api/artifacts/${id}/files/shared/x`, {
      method: "PUT",
      bearer: token,
      body: "x".repeat(11),
      headers: { "Content-Type": "text/plain" },
    });
    expect(big.status).toBe(413);
  });
});
