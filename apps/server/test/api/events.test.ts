import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sha256 } from "../../src/auth/secrets.ts";
import { artifacts, sessions, tokens } from "../../src/db/schema.ts";
import { isPushEndpoint } from "../../src/push/notify.ts";
import { Events } from "../../src/realtime/events.ts";
import { claim, createDatabase, OWNER, signIn, startTestServer } from "../helpers.ts";
import { makeAccount, publish } from "../publish-helper.ts";

/** A TCP proxy to Postgres that can be cut, for an outage long enough that the driver gives up. */
function proxy(target: URL) {
  const open = new Set<import("bun").Socket<{ peer?: import("bun").Socket<unknown> }>>();
  let up = true;
  const server = Bun.listen<{ peer?: import("bun").Socket<unknown>; early?: Uint8Array[] }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(socket) {
        if (!up) {
          socket.end();
          return;
        }
        socket.data = { early: [] };
        open.add(socket as never);
        socket.data.peer = await Bun.connect({
          hostname: target.hostname,
          port: Number(target.port),
          socket: {
            data(_, chunk) {
              socket.write(chunk);
            },
            close() {
              socket.end();
            },
          },
        });
        for (const chunk of socket.data.early ?? []) socket.data.peer.write(chunk);
      },
      data(socket, chunk) {
        if (socket.data.peer) socket.data.peer.write(chunk);
        else socket.data.early?.push(new Uint8Array(chunk));
      },
      close(socket) {
        open.delete(socket as never);
        socket.data?.peer?.end();
      },
    },
  });
  return {
    port: server.port,
    cut() {
      up = false;
      for (const socket of open) socket.end();
    },
    restore() {
      up = true;
    },
    stop: () => server.stop(true),
  };
}

describe("the event listener", () => {
  let cleanup = async () => {};
  afterAll(() => cleanup());

  test("comes back after a long outage, and closes open streams so browsers catch up", async () => {
    const database = await createDatabase();
    const url = new URL(database.url);
    const tunnel = proxy(url);
    const through = new URL(database.url);
    through.hostname = "127.0.0.1";
    through.port = String(tunnel.port);
    const events = new Events(through.toString(), 100);
    const direct = new Events(database.url, 60_000);
    cleanup = async () => {
      await events.stop();
      await direct.stop();
      tunnel.stop();
    };
    await events.start();
    const heard: string[] = [];
    let closed = 0;
    events.subscribe("a", (message) => heard.push(message.type));
    events.onLost(() => {
      closed += 1;
    });

    await direct.emit("a", "thread");
    for (let i = 0; i < 40 && heard.length === 0; i++) await Bun.sleep(25);
    expect(heard).toEqual(["thread"]);

    tunnel.cut();
    await Bun.sleep(1000);
    tunnel.restore();
    for (let i = 0; i < 80 && closed === 0; i++) await Bun.sleep(50);
    // Past a few pings, in case another attempt was still under way.
    await Bun.sleep(500);
    expect(closed).toBe(1);

    await direct.emit("a", "version");
    for (let i = 0; i < 40 && heard.length === 1; i++) await Bun.sleep(25);
    expect(heard).toEqual(["thread", "version"]);
  }, 15_000);
});

describe("push endpoints", () => {
  test("only the real push services over https, never a private address", () => {
    for (const good of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://web.push.apple.com/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://par02p.notify.windows.com/?token=abc",
    ]) {
      expect(isPushEndpoint(good)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/x",
      "https://fcm.googleapis.com.evil.test/x",
      "https://evilfcm.googleapis.com/x",
      "https://fcm.googleapis.com@127.0.0.1/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://10.0.0.5/x",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/x",
      "https://web.push.apple.com.internal/x",
      "ftp://fcm.googleapis.com/x",
      "https://evil.test/push.apple.com",
      "nonsense",
    ]) {
      expect(isPushEndpoint(bad)).toBe(false);
    }
  });
});

describe("streams end when access does", () => {
  const closes = async (response: Response) => {
    const reader = response.body?.getReader();
    for (let i = 0; i < 100; i++) {
      const { done } = (await Promise.race([
        reader?.read(),
        Bun.sleep(100).then(() => ({ done: false })),
      ])) as { done: boolean };
      if (done) return true;
    }
    await reader?.cancel();
    return false;
  };

  test("losing a team closes it within a heartbeat, for a session and a token", async () => {
    const t = await startTestServer({}, { heartbeatMs: 40 });
    try {
      const { token } = await claim(t);
      const owner = await signIn(t, OWNER.email, OWNER.password);
      await publish(t, token, { slug: "live", visibility: "me" });
      const [row] = await t.server.db.select().from(artifacts);
      const member = await makeAccount(t, row?.orgId as string, "member");
      const made = await t.api("/api/teams", { method: "POST", cookie: owner, json: { name: "Live" } });
      const { team } = (await made.json()) as { team: { id: string; slug: string } };
      const member_ = `/api/teams/${team.slug}/members/${member.id}`;
      await t.api(member_, { method: "PUT", cookie: owner, json: { role: "member" } });
      await t.api(`/api/artifacts/${row?.id}/teams/${team.id}`, {
        method: "PUT",
        cookie: owner,
        json: { permission: "view" },
      });

      const streams = await Promise.all([
        t.api(`/api/events?artifact=${row?.id}`, { cookie: member.cookie }),
        t.api(`/api/events?artifact=${row?.id}`, { bearer: member.token }),
      ]);
      expect(streams.map((response) => response.status)).toEqual([200, 200]);
      await t.api(member_, { method: "DELETE", cookie: owner });
      expect(await Promise.all(streams.map(closes))).toEqual([true, true]);
    } finally {
      await t.stop();
    }
  });

  test("a revoked token's stream ends, and an ended session's", async () => {
    const t = await startTestServer({}, { heartbeatMs: 40 });
    try {
      const { token } = await claim(t);
      await publish(t, token, { slug: "live" });
      const [row] = await t.server.db.select().from(artifacts);
      const member = await makeAccount(t, row?.orgId as string, "member");
      const open = (auth: object) => t.api(`/api/events?artifact=${row?.id}`, auth);
      const streams = await Promise.all([open({ cookie: member.cookie }), open({ bearer: member.token })]);
      await t.server.db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.personId, member.id));
      await t.server.db.delete(sessions).where(eq(sessions.personId, member.id));
      expect(await Promise.all(streams.map(closes))).toEqual([true, true]);
    } finally {
      await t.stop();
    }
  });

  test("a stream stays open while access lasts", async () => {
    const t = await startTestServer({}, { heartbeatMs: 40 });
    try {
      const { token } = await claim(t);
      await publish(t, token, { slug: "live" });
      const [row] = await t.server.db.select().from(artifacts);
      const response = await t.api(`/api/events?artifact=${row?.id}`, { bearer: token });
      const reader = response.body?.getReader();
      const beats = [await reader?.read(), await reader?.read(), await reader?.read()];
      expect(beats.every((beat) => beat?.done === false)).toBe(true);
      await reader?.cancel();
    } finally {
      await t.stop();
    }
  });
});

describe("live streams", () => {
  test("a push subscription needs a browser's real keys", async () => {
    const t = await startTestServer();
    try {
      await claim(t);
      const cookie = await signIn(t, OWNER.email, OWNER.password);
      const subscribe = (keys: { p256dh: string; auth: string }) =>
        t.api("/api/push/subscribe", {
          method: "POST",
          cookie,
          json: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys },
        });
      expect((await subscribe({ p256dh: "AAAA", auth: "AAAA" })).status).toBe(400);
      const point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
      expect(
        (await subscribe({ p256dh: point, auth: Buffer.alloc(16, 2).toString("base64url") })).status,
      ).toBe(200);
    } finally {
      await t.stop();
    }
  });

  test("an org token's ten streams are its own, not every org token's", async () => {
    const t = await startTestServer();
    try {
      const { token, person } = await claim(t);
      await publish(t, token, { slug: "live" });
      const [row] = await t.server.db.select().from(artifacts);
      const orgToken = async (secret: string) => {
        await t.server.db.insert(tokens).values({
          id: Bun.randomUUIDv7(),
          orgId: row?.orgId as string,
          kind: "org",
          name: secret,
          tokenHash: sha256(secret),
          scopes: ["read"],
          createdBy: person.id,
        });
        return secret;
      };
      const first = await orgToken("art_org_first_token");
      const second = await orgToken("art_org_second_token");
      const open = (bearer: string) => t.api(`/api/events?artifact=${row?.id}`, { bearer });
      const held = await Promise.all(Array.from({ length: 10 }, () => open(first)));
      expect(held.map((response) => response.status)).toEqual(new Array(10).fill(200));
      expect((await open(first)).status).toBe(429);
      const other = await open(second);
      expect(other.status).toBe(200);
      await Promise.all([other, ...held].map((response) => response.body?.cancel()));
    } finally {
      await t.stop();
    }
  });
});
