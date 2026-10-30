import { afterAll, describe, expect, test } from "bun:test";
import { Events } from "../../src/realtime/events.ts";
import { createDatabase } from "../helpers.ts";

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
    expect(closed).toBe(1);

    await direct.emit("a", "version");
    for (let i = 0; i < 40 && heard.length === 1; i++) await Bun.sleep(25);
    expect(heard).toEqual(["thread", "version"]);
  }, 15_000);
});
