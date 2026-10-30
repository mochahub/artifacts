import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { artifacts, people, pushSubscriptions } from "../../src/db/schema.ts";
import { isPushEndpoint, sendDigest } from "../../src/push/notify.ts";
import { claim, OWNER, signIn, startTestServer, type TestServer } from "../helpers.ts";
import { makePerson, publish } from "../publish-helper.ts";

/** A browser's half of RFC 8291, written apart from the server's. */
function browser() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") },
    decrypt(body: Uint8Array) {
      const buffer = Buffer.from(body);
      const salt = buffer.subarray(0, 16);
      const idLength = buffer.readUInt8(20);
      const sender = buffer.subarray(21, 21 + idLength);
      const cipherText = buffer.subarray(21 + idLength);
      const shared = ecdh.computeSecret(sender);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, sender]);
      const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(cipherText.subarray(-16));
      const plain = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
      expect(plain.at(-1)).toBe(2);
      return JSON.parse(plain.subarray(0, -1).toString());
    },
  };
}

describe("live review", () => {
  let t: TestServer;
  let token: string;
  let cookie: string;
  let id: string;
  let orgId: string;
  const received: { path: string; headers: Headers; body: Uint8Array }[] = [];
  let answer = 201;
  const service = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(null, { status: answer });
    },
  });
  const endpoint = (name: string) => `http://127.0.0.1:${service.port}/${name}`;

  beforeAll(async () => {
    t = await startTestServer({}, { pushAllow: (url: string) => url.startsWith("http://127.0.0.1") });
    token = (await claim(t)).token;
    cookie = await signIn(t, OWNER.email, OWNER.password);
    expect((await publish(t, token, { slug: "live" })).status).toBe(200);
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.slug, "live"));
    id = row?.id as string;
    orgId = row?.orgId as string;
  });
  afterAll(async () => {
    service.stop(true);
    await t.stop();
  });

  const comment = (body: string, by: { cookie?: string; bearer?: string } = { cookie }) =>
    t.api(`/api/artifacts/${id}/threads`, {
      method: "POST",
      ...by,
      json: { pageKey: "plan", version: 1, anchor: null, body },
    });

  async function nextEvents(response: Response, count: number) {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while ((text.match(/^event:/gm) ?? []).length < count) {
      const { value, done } = await Promise.race([
        reader.read(),
        Bun.sleep(3000).then(() => ({ value: undefined, done: true })),
      ]);
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return text;
  }

  test("a stream hears comments, versions and shared data, and no content", async () => {
    const stream = await t.api(`/api/events?artifact=${id}`, { cookie });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    await Bun.sleep(50);
    const posted = await comment("secret words");
    expect(posted.status).toBe(200);
    await t.api(`/api/artifacts/${id}/data/shared/votes`, { method: "PUT", cookie, json: { value: 1 } });
    await t.api(`/api/artifacts/${id}/data/me/mine`, { method: "PUT", cookie, json: { value: 1 } });
    expect((await publish(t, token, { slug: "live" })).status).toBe(200);
    const text = await nextEvents(stream, 3);
    expect(text).toContain("event: thread");
    expect(text).toContain("event: data");
    expect(text).toContain('"key":"votes"');
    expect(text).toContain("event: version");
    expect(text).not.toContain("secret words");
    expect(text).not.toContain("mine");
  });

  test("a stream needs read access, the same 404 as a page", async () => {
    expect((await t.api(`/api/events?artifact=${id}`)).status).toBe(401);
    expect((await t.api("/api/events?artifact=nope", { cookie })).status).toBe(404);
    const stranger = await makePerson(t, orgId, "outside");
    expect((await t.api(`/api/events?artifact=${id}`, { bearer: stranger })).status).toBe(404);
  });

  test("push: only real push services can be subscribed", async () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isPushEndpoint("https://sub.notify.windows.com/w/?token=x")).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://169.254.169.254/latest",
      "https://localhost/x",
      "https://fcm.googleapis.com:8443/x",
      "https://fcm.googleapis.com.evil.test/x",
      "https://evil.test/push.apple.com",
      "nonsense",
    ]) {
      expect(isPushEndpoint(bad)).toBe(false);
    }
  });

  test("push: the key is stable, and subscribing needs a browser session", async () => {
    const first = (await (await t.api("/api/push/key", { cookie })).json()) as { key: string };
    const second = (await (await t.api("/api/push/key", { cookie })).json()) as { key: string };
    expect(first.key).toBe(second.key);
    expect(Buffer.from(first.key, "base64url")).toHaveLength(65);
    const refused = await t.api("/api/push/subscribe", {
      method: "POST",
      cookie,
      json: { endpoint: "ftp://x.test/a", keys: { p256dh: "a", auth: "b" } },
    });
    expect(refused.status).toBe(400);
  });

  test("push: a reply reaches the thread's author, encrypted and signed, and not the replier", async () => {
    const device = browser();
    const subscribed = await t.api("/api/push/subscribe", {
      method: "POST",
      cookie,
      json: { endpoint: endpoint("owner"), keys: device.keys },
    });
    expect(subscribed.status).toBe(200);
    const thread = (await (await comment("A question")).json()) as { id: string };
    received.length = 0;

    await t.api(`/api/threads/${thread.id}/comments`, {
      method: "POST",
      cookie,
      json: { body: "Talking to myself" },
    });
    await Bun.sleep(100);
    expect(received).toHaveLength(0);

    const agent = await t.api(`/api/threads/${thread.id}/comments`, {
      method: "POST",
      bearer: token,
      json: { body: "Fixed it", agent: "Claude" },
    });
    expect(agent.status).toBe(200);
    for (let i = 0; i < 40 && received.length === 0; i++) await Bun.sleep(25);
    expect(received).toHaveLength(1);
    const [message] = received;
    expect(message?.headers.get("content-encoding")).toBe("aes128gcm");
    expect(message?.headers.get("authorization")).toMatch(/^vapid t=.+\..+\..+, k=/);
    const opened = device.decrypt(message?.body as Uint8Array);
    expect(opened.title).toBe("Claude replied");
    expect(opened.body).toBe("Fixed it");
    expect(opened.url).toContain("/live?c=");
  });

  test("push: an agent's publish tells its person, and a person's own doesn't", async () => {
    received.length = 0;
    expect((await publish(t, token, { slug: "live" })).status).toBe(200);
    await Bun.sleep(100);
    expect(received).toHaveLength(0);
    expect((await publish(t, token, { slug: "live", agent: "Claude" })).status).toBe(200);
    for (let i = 0; i < 40 && received.length === 0; i++) await Bun.sleep(25);
    expect(received).toHaveLength(1);
  });

  test("push: someone who can't see the artifact isn't told", async () => {
    received.length = 0;
    const outsider = await makePerson(t, orgId, "outside");
    const [row] = await t.server.db.select().from(people).where(eq(people.role, "outside"));
    expect(outsider).toBeTruthy();
    await t.server.db.insert(pushSubscriptions).values({
      id: Bun.randomUUIDv7(),
      orgId,
      personId: row?.id as string,
      endpoint: endpoint("outsider"),
      keys: browser().keys,
    });
    await sendDigest(t.server.deps);
    expect(received.filter((entry) => entry.path === "/outsider")).toHaveLength(0);
  });

  test("push: a gone device is forgotten, and the digest counts what others did", async () => {
    received.length = 0;
    await makePerson(t, orgId, "member");
    const [other] = await t.server.db.select().from(people).where(eq(people.role, "member"));
    const device = browser();
    await t.server.db.insert(pushSubscriptions).values({
      id: Bun.randomUUIDv7(),
      orgId,
      personId: other?.id as string,
      endpoint: endpoint("gone"),
      keys: device.keys,
    });
    await comment("Something new");
    await sendDigest(t.server.deps);
    const digest = received.find((entry) => entry.path === "/gone");
    expect(device.decrypt(digest?.body as Uint8Array).title).toBe("Today in Artifacts");

    answer = 410;
    received.length = 0;
    await sendDigest(t.server.deps);
    answer = 201;
    const left = await t.server.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint("gone")));
    expect(left).toHaveLength(0);
  });

  test("push: unsubscribing stops it", async () => {
    await t.api("/api/push/subscribe", {
      method: "DELETE",
      cookie,
      json: { endpoint: endpoint("owner") },
    });
    const left = await t.server.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint("owner")));
    expect(left).toHaveLength(0);
  });

  test("search finds titles, pages and comments the caller can see, and treats % as a character", async () => {
    await comment("Needle in the comment");
    const find = async (q: string, as: { cookie?: string; bearer?: string } = { cookie }) =>
      (await (await t.api(`/api/search?q=${encodeURIComponent(q)}`, as)).json()) as {
        artifacts: { slug: string }[];
        pages: unknown[];
        comments: { body: string }[];
      };
    expect((await find("needle")).comments[0]?.body).toContain("Needle");
    expect((await find("live")).artifacts.map((row) => row.slug)).toContain("live");
    expect((await find("%")).comments).toEqual([]);
    expect((await find("%%%")).comments).toEqual([]);
    expect((await find("x")).artifacts).toEqual([]);
    const bearer = await makePerson(t, orgId, "outside");
    expect((await find("needle", { bearer })).comments).toEqual([]);
    expect((await find("live", { bearer })).artifacts).toEqual([]);
  });

  test("compare reports the renders and regions of a changed frame", async () => {
    const compare = await t.api(`/api/artifacts/${id}/compare?from=1&to=2`, { cookie });
    expect(compare.status).toBe(200);
    const body = (await compare.json()) as { frames: { regions: Record<string, unknown> } };
    expect(body.frames.regions).toEqual(expect.any(Object));
  });

  test("admins hear about a newer release, and nothing else breaks when GitHub can't say", async () => {
    const real = globalThis.fetch;
    const env = t.server.deps.env as { githubReleasesRepo: string | null };
    env.githubReleasesRepo = "mochahub/artifacts";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://api.github.com/")
        ? Response.json({ tag_name: "v99.0.0" })
        : real(input, init)) as typeof fetch;
    const body = (await (await t.api("/api/org", { cookie })).json()) as { newVersion: string | null };
    globalThis.fetch = real;
    env.githubReleasesRepo = null;
    expect(body.newVersion).toBe("99.0.0");
  });

  test("a share link unfurls with its title and cover; other addresses say nothing", async () => {
    const made = await t.api(`/api/artifacts/${id}/links`, {
      method: "POST",
      cookie,
      json: { permission: "view" },
    });
    const { url } = (await made.json()) as { url: string };
    const page = (path: string) => t.api(path, { headers: { Accept: "text/html" } });
    const shared = await (await page(new URL(url).pathname)).text();
    expect(shared).toContain('property="og:image"');
    expect(shared).toContain('property="og:title"');
    const [row] = await t.server.db.select().from(artifacts).where(eq(artifacts.id, id));
    expect(shared).toContain(row?.title.replaceAll("&", "&#38;") as string);
    const plain = await (await page("/demo/live")).text();
    expect(plain).not.toContain("og:image");
    expect(plain).not.toContain(row?.title as string);
    expect(await (await page("/s/not-a-token")).text()).not.toContain("og:image");
  });
});
