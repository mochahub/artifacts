import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedAddresses, sourceTransport } from "./transport.ts";

test("real TLS fixture: pinning, hostname verification, redirect/compression/MIME/stream/deadline refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "librarian-tls-"));
  let hits = 0,
    resolutions = 0,
    pins = 0;
  const sockets = new Set<import("node:net").Socket>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const cert = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key"),
      "-out",
      join(dir, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=fixture.test",
      "-addext",
      "subjectAltName=DNS:fixture.test",
    ],
    { stdio: "ignore" },
  );
  expect(cert.status).toBe(0);
  const ca = readFileSync(join(dir, "cert"));
  const server = createServer({ key: readFileSync(join(dir, "key")), cert: ca }, (req, res) => {
    hits++;
    expect(req.headers.host).toBe("fixture.test");
    expect(req.headers["accept-encoding"]).toBe("identity");
    expect(req.headers.authorization).toBeUndefined();
    res.setHeader("Content-Type", req.url === "/mime" ? "application/pdf" : "text/plain");
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "https://private.test/" });
      res.end();
    } else if (req.url === "/gzip") {
      res.setHeader("Content-Encoding", "gzip");
      res.end("compressed");
    } else if (req.url === "/overflow") {
      res.end(Buffer.alloc(5 * 1024 * 1024 + 1));
    } else if (req.url === "/abort") {
      res.write("partial");
      timers.push(setTimeout(() => res.destroy(), 30));
    } else if (req.url === "/timeout") {
      /* connection remains open until total deadline */
    } else res.end("fixture body");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  // Only the test dialer maps the validated public address onto a private TLS fixture.
  // The production resolver and request implementation are untouched.
  const dial = ((
    url: URL,
    options: Parameters<typeof request>[1],
    callback: Parameters<typeof request>[2],
  ) => {
    const opts = options as import("node:https").RequestOptions;
    expect(opts.servername).toBe(url.hostname);
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.agent).toBe(false);
    const r = request(
      url,
      {
        ...opts,
        port: address.port,
        ca,
        headers: { ...opts.headers, Host: url.hostname },
        lookup: (host, lookupOptions, cb) => {
          if (!opts.lookup) throw new Error("pin_missing");
          opts.lookup(host, lookupOptions, (err, ip, family) => {
            expect(err).toBeNull();
            expect(ip).toBe("8.8.8.8");
            expect(family).toBe(4);
            pins++;
            cb(null, "127.0.0.1", 4);
          });
        },
      },
      callback,
    );
    return r;
  }) as typeof request;
  const fetch = sourceTransport(async () => {
    resolutions++;
    return [{ address: "8.8.8.8", family: 4 }];
  }, dial);
  try {
    expect(Buffer.from((await fetch("https://fixture.test/ok")).bytes).toString()).toBe("fixture body");
    for (const path of ["redirect", "gzip", "mime", "overflow", "abort", "timeout"])
      await expect(fetch(`https://fixture.test/${path}`)).rejects.toThrow();
    const before = hits;
    await expect(fetch("https://wrong.test/")).rejects.toThrow();
    expect(hits).toBe(before); // TLS hostname mismatch prevented HTTP delivery.
    expect(resolutions).toBe(8);
    expect(pins).toBe(8);
    expect(hits).toBe(7);
    let calls = 0;
    const rebound = sourceTransport(
      async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
      dial,
    );
    await rebound("https://fixture.test/ok");
    await expect(rebound("https://fixture.test/ok")).rejects.toThrow("destination");
    await expect(
      pinnedAddresses("fixture.test", async () => [{ address: "8.8.8.8", family: 6 }]),
    ).rejects.toThrow("destination");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
