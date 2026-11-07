import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  createVerify,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  claim,
  OPS_SECRET,
  OWNER,
  readEvents,
  signIn,
  solidImage,
  startTestServer,
  type TestServer,
} from "../helpers.ts";
import { hash, makeAccount, makePerson, publish, published } from "../publish-helper.ts";

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
  /** A member with a device, who has a say in the owner's first thread. */
  let member: Awaited<ReturnType<typeof makeAccount>>;
  const owner = browser();
  const received: { path: string; headers: Headers; body: Uint8Array }[] = [];
  /**
   * Every endpoint the server was about to send to, in order. A delivery checks each of its devices here
   * in one pass before it sends to any, so once one device of a delivery is listed, all of them are.
   */
  const attempted: string[] = [];
  const gone = new Set<string>();
  const service = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      received.push({ path, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(null, { status: gone.has(path) ? 410 : 201 });
    },
  });
  const endpoint = (name: string) => `http://127.0.0.1:${service.port}/${name}`;
  const at = (name: string) => received.filter((entry) => entry.path === `/${name}`);
  const tried = (name: string) => attempted.filter((url) => url === endpoint(name)).length;
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 80 && !done(); i++) await Bun.sleep(25);
    expect(done()).toBe(true);
  };
  const clear = () => {
    received.length = 0;
    attempted.length = 0;
  };

  beforeAll(async () => {
    t = await startTestServer(
      {},
      {
        pushAllow: (url: string) => {
          attempted.push(url);
          return url.startsWith("http://127.0.0.1");
        },
      },
    );
    ({ token, orgId } = await claim(t));
    cookie = await signIn(t, OWNER.email, OWNER.password);
    ({ id } = await published(t, token, { slug: "live" }));
    member = await makeAccount(t, orgId, "member");
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
  const reply = (threadId: string, body: string, by: { cookie?: string; bearer?: string; agent?: string }) =>
    t.api(`/api/threads/${threadId}/comments`, {
      method: "POST",
      cookie: by.cookie,
      bearer: by.bearer,
      json: { body, agent: by.agent },
    });
  const subscribe = async (as: string, name: string, keys = browser().keys) => {
    const response = await t.api("/api/push/subscribe", {
      method: "POST",
      cookie: as,
      json: { endpoint: endpoint(name), keys },
    });
    expect(response.status).toBe(200);
  };
  /** The daily job, the way an operator's cron runs it. It returns once every push it sent is answered. */
  const digest = async () => {
    const response = await fetch(`http://127.0.0.1:${t.server.ports.internal}/internal/jobs/digest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPS_SECRET}` },
    });
    expect(response.status).toBe(200);
  };
  const quietDay = () => t.clock.advance(21 * 3600_000);

  test("a stream hears comments, versions and shared data, and no content", async () => {
    const stream = await t.api(`/api/events?artifact=${id}`, { cookie });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const posted = await comment("secret words");
    expect(posted.status).toBe(200);
    await t.api(`/api/artifacts/${id}/data/shared/votes`, { method: "PUT", cookie, json: { value: 1 } });
    await t.api(`/api/artifacts/${id}/data/me/mine`, { method: "PUT", cookie, json: { value: 1 } });
    expect((await publish(t, token, { slug: "live" })).status).toBe(200);
    const text = await readEvents(stream, 3);
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
    const stranger = (await makePerson(t, orgId, "outside")).token;
    expect((await t.api(`/api/events?artifact=${id}`, { bearer: stranger })).status).toBe(404);
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

  test("push: a reply reaches the others in the thread, encrypted and signed, and not the replier", async () => {
    await subscribe(cookie, "owner", owner.keys);
    await subscribe(member.cookie, "member");
    const thread = (await (await comment("A question")).json()) as { id: string; n: number };
    expect((await reply(thread.id, "Me too", { cookie: member.cookie })).status).toBe(200);
    await until(() => at("owner").length === 1);
    clear();

    // The member hears the owner's own reply; the owner, in the same delivery, isn't even tried.
    expect((await reply(thread.id, "Talking to myself", { cookie })).status).toBe(200);
    await until(() => tried("member") === 1);
    expect(tried("owner")).toBe(0);

    // An agent writes with its person's token, and still has news for them.
    clear();
    expect((await reply(thread.id, "Fixed it", { bearer: token, agent: "Claude" })).status).toBe(200);
    await until(() => at("owner").length === 1);
    const [message] = at("owner");
    expect(message?.headers.get("content-encoding")).toBe("aes128gcm");
    expect(message?.headers.get("authorization")).toMatch(/^vapid t=.+\..+\..+, k=/);
    const opened = owner.decrypt(message?.body as Uint8Array);
    expect(opened.title).toBe("Zahin's Claude replied");
    expect(opened.body).toBe("Fixed it");
    expect(opened.url).toBe(`/camerabuddy/live/plan?c=${thread.n}`);

    const [, jwt, publicKey] = /^vapid t=(.+), k=(.+)$/.exec(
      message?.headers.get("authorization") as string,
    ) as string[];
    const [header, claims, signature] = (jwt as string).split(".") as [string, string, string];
    const point = Buffer.from(publicKey as string, "base64url");
    const key = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
    });
    const valid = createVerify("sha256")
      .update(`${header}.${claims}`)
      .verify({ key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    expect(valid).toBe(true);
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(decoded.aud).toBe(`http://127.0.0.1:${service.port}`);
    expect(decoded.exp * 1000).toBeGreaterThan(Date.now());
    expect(decoded.exp * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  });

  test("push: an agent's publish tells its person, and a person's own doesn't", async () => {
    clear();
    const own = await published(t, token, { slug: "live" });
    const agent = await published(t, token, { slug: "live", agent: "Claude" });
    // The person's own publish came first; had it sent anything, it would be here before the agent's.
    await until(() => at("owner").length === 1);
    expect(tried("owner")).toBe(1);
    expect(owner.decrypt(at("owner")[0]?.body as Uint8Array).title).toBe(
      `Zahin's Claude published v${agent.version}`,
    );
    expect(agent.version).toBe(own.version + 1);
  });

  test("push: someone who can't see the artifact isn't told", async () => {
    const outsider = await makeAccount(t, orgId, "outside");
    await subscribe(outsider.cookie, "outsider");
    quietDay();
    expect((await comment("News for the member", { cookie: member.cookie })).status).toBe(200);
    clear();
    await digest();
    // The digest went out (the owner has news), and passed the outsider by.
    expect(at("owner")).toHaveLength(1);
    expect(tried("outsider")).toBe(0);
  });

  test("push: a gone device is forgotten, and the digest counts what others did", async () => {
    const other = await makeAccount(t, orgId, "member");
    const device = browser();
    await subscribe(other.cookie, "gone", device.keys);
    await subscribe(other.cookie, "kept");
    quietDay();
    await comment("Something new");
    clear();
    await digest();
    expect(device.decrypt(at("gone")[0]?.body as Uint8Array).title).toBe("Today in Artifacts");

    // Once a day, however often the job runs.
    clear();
    await digest();
    expect(received).toHaveLength(0);

    gone.add("/gone");
    quietDay();
    await comment("And again");
    await digest();
    gone.clear();

    quietDay();
    await comment("And once more");
    clear();
    await digest();
    expect(at("kept")).toHaveLength(1);
    expect(tried("gone")).toBe(0);
  });

  test("push: someone who lost the artifact, or whose session ended, hears nothing more", async () => {
    const lost = await makeAccount(t, orgId, "member");
    const thread = (await (await comment("Private soon")).json()) as { id: string };
    await subscribe(lost.cookie, "lost");
    clear();
    expect((await reply(thread.id, "Me too", { cookie: lost.cookie })).status).toBe(200);
    await until(() => tried("owner") === 1);
    const agentReply = (body: string) => reply(thread.id, body, { bearer: token, agent: "Claude" });
    clear();
    await agentReply("Heard");
    await until(() => at("lost").length === 1);

    const visibility = (value: "me" | "org") =>
      t.api(`/api/artifacts/${id}`, { method: "PATCH", cookie, json: { visibility: value } });
    expect((await visibility("me")).status).toBe(200);
    clear();
    await agentReply("Not for you");
    // The owner is in the same delivery, so once they're tried, everyone the delivery chose was.
    await until(() => tried("owner") === 1);
    expect(tried("lost")).toBe(0);
    expect((await visibility("org")).status).toBe(200);

    expect((await t.api("/api/auth/logout", { method: "POST", cookie: lost.cookie })).status).toBe(200);
    clear();
    await agentReply("Gone now");
    await until(() => tried("owner") === 1);
    expect(tried("lost")).toBe(0);
  });

  test("streams: ten per caller, and closing one frees its place", async () => {
    const open = await Promise.all(
      Array.from({ length: 10 }, () => t.api(`/api/events?artifact=${id}`, { cookie })),
    );
    expect(open.map((response) => response.status)).toEqual(new Array(10).fill(200));
    expect((await t.api(`/api/events?artifact=${id}`, { cookie })).status).toBe(429);
    await open[0]?.body?.cancel();
    let again = await t.api(`/api/events?artifact=${id}`, { cookie });
    for (let i = 0; i < 40 && again.status === 429; i++) {
      await Bun.sleep(25);
      again = await t.api(`/api/events?artifact=${id}`, { cookie });
    }
    expect(again.status).toBe(200);
    await Promise.all([again, ...open.slice(1)].map((response) => response.body?.cancel()));
  });

  test("a render can be fetched through the app, for the service worker", async () => {
    const png = await solidImage(8, 8, "#123456", "png");
    const { id: bytes, renderHash } = await published(t, token, { slug: "bytes", renderBytes: png });
    const through = await t.api(`/api/artifacts/${bytes}/r/${renderHash}?via=app`, { cookie });
    expect(through.status).toBe(200);
    expect(new Uint8Array(await through.arrayBuffer())).toEqual(new Uint8Array(png));
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
    const bearer = (await makePerson(t, orgId, "outside")).token;
    expect((await find("needle", { bearer })).comments).toEqual([]);
    expect((await find("live", { bearer })).artifacts).toEqual([]);
  });

  test("compare reports the renders and regions of a changed frame", async () => {
    const version = async (frameHash: string, background: string) =>
      published(t, token, {
        slug: "pixels",
        frameHash,
        renderBytes: await solidImage(400, 800, background, "png"),
      });
    await version(hash("x"), "#ffffff");
    const { id: pixels } = await version(hash("y"), "#000000");
    const compare = await t.api(`/api/artifacts/${pixels}/compare?from=1&to=2`, { cookie });
    expect(compare.status).toBe(200);
    const body = (await compare.json()) as {
      frames: { regions: Record<string, { before: string; after: string; regions: unknown[] }> };
    };
    const frame = body.frames.regions["mocks/live-view"];
    expect(frame?.before).not.toBe(frame?.after);
    expect(frame?.regions).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });

  test("admins hear about a newer release, and nothing else breaks when GitHub can't say", async () => {
    const real = globalThis.fetch;
    const env = t.server.deps.env as { githubReleasesRepo: string | null };
    env.githubReleasesRepo = "mochahub/artifacts";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://api.github.com/")
        ? Response.json({ tag_name: "v99.0.0" })
        : real(input, init)) as typeof fetch;
    try {
      const body = (await (await t.api("/api/org", { cookie })).json()) as { newVersion: string | null };
      expect(body.newVersion).toBe("99.0.0");
    } finally {
      globalThis.fetch = real;
      env.githubReleasesRepo = null;
    }
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
    expect(shared).toContain('content="Roadmap"');
    const plain = await (await page("/demo/live")).text();
    expect(plain).not.toContain("og:image");
    expect(plain).not.toContain("Roadmap");
    expect(await (await page("/s/not-a-token")).text()).not.toContain("og:image");
  });

  test("push: unsubscribing stops it", async () => {
    const thread = (await (await comment("Last one")).json()) as { id: string };
    clear();
    expect((await reply(thread.id, "Watching", { cookie: member.cookie })).status).toBe(200);
    await until(() => tried("owner") === 1);
    const unsubscribed = await t.api("/api/push/subscribe", {
      method: "DELETE",
      cookie,
      json: { endpoint: endpoint("owner") },
    });
    expect(unsubscribed.status).toBe(200);
    clear();
    await reply(thread.id, "For both of you", { bearer: token, agent: "Claude" });
    await until(() => tried("member") === 1);
    expect(tried("owner")).toBe(0);
  });
});
