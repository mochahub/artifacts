import { expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { extractBytes } from "../../../apps/server/src/librarian/ingestion/extractor.ts";
import {
  digest,
  matches,
  remoteExtractor,
  signature,
  signedHeaders,
} from "../../../apps/server/src/librarian/ingestion/remote-extractor.ts";
import { executor, recover } from "./server.ts";

const key = new Uint8Array(32).fill(42); // Synthetic private fixture only.
const image = process.env.TEST_LIBRARIAN_EXTRACTOR_IMAGE;
const qualified = image ? test : test.skip;
function pdf(pages = 1, extra = "", text = true): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    const stream = text ? "BT /F1 12 Tf 72 720 Td (Qualification PDF) Tj ET" : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R ${extra} >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  out += offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(`${out}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
qualified(
  "real private client, authenticated admission and parser results",
  async () => {
    const scope = `test-${crypto.randomUUID()}`;
    const service = executor({ image: image ?? "", key, scope });
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    const address = service.server.address();
    if (!address || typeof address === "string") throw Error();
    const endpoint = `http://127.0.0.1:${address.port}`;
    const client = remoteExtractor({ endpoint, key, testOnlyLoopbackHttp: true });
    const raw = async (path: string, body: Buffer, headers: Record<string, string>) =>
      fetch(endpoint + path, { method: "POST", headers, body: new Uint8Array(body) });
    try {
      for (const mime of ["text/plain", "text/markdown", "text/html"])
        expect(
          await extractBytes(Buffer.from(mime === "text/html" ? "<p>hello</p>" : "hello"), mime, client),
        ).toBe("hello");
      expect(await extractBytes(pdf(), "application/pdf", client)).toContain("Qualification PDF");
      const body = Buffer.from("hello"),
        path = `/extract/${crypto.randomUUID()}`;
      const headers = signedHeaders(
        key,
        path,
        "text/plain",
        body,
        Date.now(),
        crypto.randomUUID(),
        service.epoch,
      );
      const result = await raw(path, body, headers);
      expect(result.status).toBe(200);
      await result.text();
      const replay = await raw(path, body, headers);
      expect(replay.status).toBe(409);
      const replayBody = Buffer.from(await replay.text());
      expect(
        matches(
          replay.headers.get("x-executor-signature") ?? "",
          signature(key, ["response-v1", path, headers["x-executor-nonce"] ?? "", "409", digest(replayBody)]),
        ),
      ).toBe(true);
      expect(
        (
          await raw(
            path,
            body,
            signedHeaders(
              new Uint8Array(32).fill(1),
              path,
              "text/plain",
              body,
              Date.now(),
              crypto.randomUUID(),
              service.epoch,
            ),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await raw(
            path,
            body,
            signedHeaders(
              key,
              path,
              "text/plain",
              body,
              Date.now() - 31000,
              crypto.randomUUID(),
              service.epoch,
            ),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await raw(
            path,
            Buffer.from("other"),
            signedHeaders(key, path, "text/plain", body, Date.now(), crypto.randomUUID(), service.epoch),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await raw(
            path,
            body,
            signedHeaders(
              key,
              path,
              "text/plain",
              body,
              Date.now(),
              crypto.randomUUID(),
              crypto.randomUUID(),
            ),
          )
        ).status,
      ).toBe(401);
      const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 97);
      expect(
        (
          await raw(
            path,
            huge,
            signedHeaders(key, path, "text/plain", huge, Date.now(), crypto.randomUUID(), service.epoch),
          )
        ).status,
      ).toBe(413);
      await expect(extractBytes(Buffer.alloc(1048577, 97), "text/plain", client)).rejects.toThrow();
    } finally {
      service.abortAll();
      service.server.closeAllConnections();
      service.server.close();
      await recover(scope);
    }
  },
  60000,
);

qualified(
  "concurrency, cancellation, disconnect and restart orphan recovery",
  async () => {
    const scope = `test-${crypto.randomUUID()}`,
      tag = `librarian-remote-probe-${crypto.randomUUID()}:local`;
    execFileSync("docker", ["tag", image ?? "", `${tag}-base`]);
    const build = spawnSync("docker", ["build", "-q", "-t", tag, "-"], {
      input: `FROM ${tag}-base\nENTRYPOINT ["python3", "-I", "-c", "import time; time.sleep(60)"]\n`,
      encoding: "utf8",
    });
    if (build.status !== 0) throw Error("probe_build_failed");
    const probe = execFileSync("docker", ["image", "inspect", "--format={{.Id}}", tag], {
      encoding: "utf8",
    }).trim();
    const service = executor({ image: probe, key, scope });
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    const address = service.server.address();
    if (!address || typeof address === "string") throw Error();
    const endpoint = `http://127.0.0.1:${address.port}`;
    async function request(kind: string, id: string, signal?: AbortSignal) {
      const body = kind === "cancel" ? Buffer.alloc(0) : Buffer.from("hello");
      const path = `/${kind}/${id}`;
      return fetch(endpoint + path, {
        method: "POST",
        body,
        headers: signedHeaders(
          key,
          path,
          kind === "cancel" ? "application/octet-stream" : "text/plain",
          body,
          Date.now(),
          crypto.randomUUID(),
          service.epoch,
        ),
        signal,
      });
    }
    try {
      const a = crypto.randomUUID(),
        b = crypto.randomUUID();
      const disconnected = new AbortController();
      const first = request("extract", a).then((r) => r.status);
      const second = request("extract", b, disconnected.signal).catch(() => null);
      // Wait for admission only; bounded private fixture, no shared stack polling.
      for (let n = 0; service.active() < 2 && n < 100; n++) await new Promise((r) => setTimeout(r, 10));
      expect(service.active()).toBe(2);
      expect((await request("extract", crypto.randomUUID())).status).toBe(429);
      expect((await request("cancel", a)).status).toBe(200);
      disconnected.abort();
      expect(await first).toBe(422);
      await second;
      service.abortAll();
      service.server.closeAllConnections();
      service.server.close();
      await recover(scope);
      // Kill a real executor process while its sandbox is running, then run startup reconciliation.
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
        import { executor } from ${JSON.stringify(new URL("./server.ts", import.meta.url).pathname)};
        const service = executor({image:${JSON.stringify(probe)}, key:new Uint8Array(32).fill(42), scope:${JSON.stringify(scope)}});
        service.server.listen(0,"127.0.0.1",()=>console.log(service.server.address().port));
      `,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const [port] = await once(child.stdout, "data");
        const crashedClient = remoteExtractor({
          endpoint: `http://127.0.0.1:${String(port).trim()}`,
          key,
          testOnlyLoopbackHttp: true,
        });
        const result = extractBytes(Buffer.from("hello"), "text/plain", crashedClient).catch(
          () => "rejected",
        );
        let found = false;
        for (let n = 0; n < 100; n++) {
          found = !!execFileSync(
            "docker",
            ["ps", "-q", "--filter", `label=artifacts.private-executor=${scope}`],
            { encoding: "utf8" },
          ).trim();
          if (found) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(found).toBe(true);
        child.kill("SIGKILL");
        await once(child, "close");
        expect(await result).toBe("rejected");
        await recover(scope);
      } finally {
        child.kill("SIGKILL");
      }
      expect(
        execFileSync("docker", ["ps", "-aq", "--filter", `label=artifacts.private-executor=${scope}`], {
          encoding: "utf8",
        }).trim(),
      ).toBe("");
    } finally {
      service.abortAll();
      service.server.closeAllConnections();
      service.server.close();
      await recover(scope);
      execFileSync("docker", ["image", "rm", tag, `${tag}-base`]);
    }
  },
  60000,
);
