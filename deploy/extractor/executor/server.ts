import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
  checkKey,
  digest,
  INPUT_LIMIT,
  matches,
  OUTPUT_LIMIT,
  signature,
} from "../../../apps/server/src/librarian/ingestion/remote-extractor.ts";
import { launch, liveContainers } from "./launcher.ts";

const exec = promisify(execFile);

/** Called only under the exclusive service lock, before accepting requests. Fail closed on daemon errors. */
export async function recover(scope = "v1", preserve: ReadonlySet<string> = new Set()): Promise<void> {
  const { stdout } = await exec(
    "docker",
    ["ps", "-a", "--format={{.ID}} {{.Names}}", "--filter", `label=artifacts.private-executor=${scope}`],
    {
      timeout: 5000,
    },
  );
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const [id, name] = line.split(" ");
    if (!id || !name || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error("executor_recovery_failed");
    if (!preserve.has(name)) await exec("docker", ["rm", "-f", id], { timeout: 5000 });
  }
}

export function executor(config: { image: string; key: Uint8Array; scope?: string }) {
  checkKey(config.key);
  if (!/^sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error("extractor_image_required");
  const key = Uint8Array.from(config.key);
  const scope = config.scope ?? "v1";
  if (!/^[a-z0-9-]{1,64}$/.test(scope)) throw new Error("executor_scope_required");
  const boot = Date.now();
  const epoch = crypto.randomUUID();
  const seen = new Map<string, number>();
  const jobs = new Map<string, AbortController>();
  let unhealthy = false;
  let window = boot,
    admitted = 0,
    pending = 0;
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    if (req.method === "GET" && /^\/session\/[a-f0-9-]{36}$/.test(path)) {
      res.writeHead(204, {
        "x-executor-epoch": epoch,
        "x-executor-signature": signature(key, ["session-v1", path, epoch]),
        connection: "close",
      });
      res.end();
      return;
    }
    const requestEpoch = String(req.headers["x-executor-epoch"] ?? "");
    const nonce = String(req.headers["x-executor-nonce"] ?? "");
    const time = String(req.headers["x-executor-time"] ?? "");
    const mime = String(req.headers["content-type"] ?? "");
    const hash = String(req.headers["x-executor-hash"] ?? "");
    const sig = String(req.headers["x-executor-signature"] ?? "");
    const reply = (status: number, message: string) => {
      const bytes = Buffer.from(message);
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "x-executor-signature": signature(key, ["response-v1", path, nonce, String(status), digest(bytes)]),
        connection: "close",
      });
      res.end(bytes);
    };
    const now = Date.now();
    const route = /^\/(extract|cancel)\/([a-f0-9-]{36})$/.exec(path);
    if (
      req.method !== "POST" ||
      requestEpoch !== epoch ||
      !route ||
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !/^\d{13}$/.test(time) ||
      Number(time) < boot ||
      Math.abs(now - Number(time)) > 30000 ||
      !matches(sig, signature(key, ["request-v1", "POST", path, time, nonce, mime, hash, requestEpoch]))
    )
      return reply(401, "unauthorized");
    for (const [n, expires] of seen) if (expires < now) seen.delete(n);
    if (seen.has(nonce)) return reply(409, "replay");
    if (seen.size >= 4096) return reply(429, "capacity");
    seen.set(nonce, now + 61000);
    const cancel = route[1] === "cancel";
    const id = route[2] ?? "";
    const length = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 0 || length > (cancel ? 0 : INPUT_LIMIT))
      return reply(413, "size");
    if (!cancel && (unhealthy || pending >= 2 || jobs.has(id))) return reply(429, "capacity");
    if (now - window >= 60000) {
      window = now;
      admitted = 0;
    }
    if (!cancel && admitted >= 60) return reply(429, "quota");
    if (!cancel) {
      pending++;
      admitted++;
    }
    const controller = new AbortController();
    if (!cancel) jobs.set(id, controller);
    const abort = () => controller.abort();
    res.on("close", abort);
    const deadline = setTimeout(() => {
      controller.abort();
      req.destroy();
    }, 20000);
    const uploadDeadline = setTimeout(() => {
      controller.abort();
      req.destroy();
    }, 5000);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > length || controller.signal.aborted) throw new Error("rejected");
        chunks.push(Buffer.from(chunk));
      }
      clearTimeout(uploadDeadline);
      const body = Buffer.concat(chunks);
      if (size !== length || digest(body) !== hash) return reply(401, "unauthorized");
      if (cancel) {
        jobs.get(id)?.abort();
        return reply(200, "cancelled");
      }
      const text = await launch(
        config.image,
        controller.signal,
        scope,
      )({
        bytes: body,
        mime,
        network: false,
        memoryBytes: 268435456,
        cpuSeconds: 10,
        maxPages: 100,
        maxOutputBytes: OUTPUT_LIMIT,
      });
      if (
        controller.signal.aborted ||
        Buffer.byteLength(text) > OUTPUT_LIMIT ||
        !text.trim() ||
        text.includes("\0")
      )
        throw new Error("rejected");
      reply(200, text);
    } catch (error) {
      if (error instanceof Error && error.message === "executor_cleanup_failed") unhealthy = true;
      if (!res.destroyed) reply(422, "extraction_rejected");
    } finally {
      clearTimeout(deadline);
      clearTimeout(uploadDeadline);
      res.off("close", abort);
      if (!cancel) {
        jobs.delete(id);
        pending--;
      }
    }
  });
  server.maxConnections = 16;
  server.requestTimeout = 6000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1;
  return {
    epoch,
    server,
    abortAll() {
      for (const job of jobs.values()) job.abort();
    },
    active: () => pending,
    disable() {
      unhealthy = true;
    },
  };
}

if (import.meta.main) {
  const keyFile = process.env.EXECUTOR_KEY_FILE;
  const image = process.env.EXECUTOR_IMAGE ?? "";
  const host = process.env.EXECUTOR_BIND ?? "127.0.0.1";
  const port = Number(process.env.EXECUTOR_PORT ?? "8090");
  if (!keyFile || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("executor_configuration_required");
  const key = await Bun.file(keyFile).bytes();
  await recover();
  const service = executor({ image, key });
  service.server.listen(port, host);
  // Reconcile late daemon creates from a killed previous launcher, not only startup's first snapshot.
  let reconciling = false;
  const reaper = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await recover("v1", liveContainers);
    } catch {
      service.disable();
      service.abortAll();
    } finally {
      reconciling = false;
    }
  }, 5000);
  reaper.unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      clearInterval(reaper);
      service.abortAll();
      service.server.close();
    });
}
