import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type SandboxedExtractor, validateSource } from "./extractor.ts";

export const INPUT_LIMIT = 10 * 1024 * 1024;
export const OUTPUT_LIMIT = 1048576;
export function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
export function signature(key: Uint8Array, fields: string[]): string {
  return createHmac("sha256", key).update(fields.join("\n")).digest("hex");
}
export function matches(a: string, b: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}
export function checkKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error("executor_key_required");
}
export function signedHeaders(
  key: Uint8Array,
  path: string,
  mime: string,
  body: Uint8Array,
  now = Date.now(),
  nonce = crypto.randomUUID(),
  epoch = "",
): Record<string, string> {
  const time = String(now);
  const hash = digest(body);
  return {
    "content-type": mime,
    "x-executor-time": time,
    "x-executor-epoch": epoch,
    "x-executor-nonce": nonce,
    "x-executor-hash": hash,
    "x-executor-signature": signature(key, ["request-v1", "POST", path, time, nonce, mime, hash, epoch]),
  };
}

/** Construction-only fixed private origin. No environment discovery or automatic enablement. */
export function remoteExtractor(config: {
  endpoint: string;
  key: Uint8Array;
  testOnlyLoopbackHttp?: boolean;
  signal?: AbortSignal;
}): SandboxedExtractor {
  const url = new URL(config.endpoint);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(config.testOnlyLoopbackHttp && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new Error("executor_endpoint_required");
  checkKey(config.key);
  const key = Uint8Array.from(config.key);
  async function send(path: string, mime: string, body: Uint8Array, signal: AbortSignal): Promise<string> {
    const sessionNonce = crypto.randomUUID();
    const sessionPath = `/session/${sessionNonce}`;
    const session = await fetch(new URL(sessionPath, url), { signal, redirect: "error" });
    const epoch = session.headers.get("x-executor-epoch") ?? "";
    if (
      session.status !== 204 ||
      !/^[a-f0-9-]{36}$/.test(epoch) ||
      !matches(
        session.headers.get("x-executor-signature") ?? "",
        signature(key, ["session-v1", sessionPath, epoch]),
      )
    )
      throw new Error("extractor_unavailable");
    await session.body?.cancel();
    const headers = signedHeaders(key, path, mime, body, Date.now(), crypto.randomUUID(), epoch);
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers,
      body: Buffer.from(body),
      signal,
      redirect: "error",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("extractor_unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > OUTPUT_LIMIT) throw new Error("extraction_rejected");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    const expected = signature(key, [
      "response-v1",
      path,
      headers["x-executor-nonce"] ?? "",
      String(response.status),
      digest(bytes),
    ]);
    if (!matches(response.headers.get("x-executor-signature") ?? "", expected))
      throw new Error("extractor_unavailable");
    if (response.status !== 200) throw new Error("extraction_rejected");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return async ({ bytes, mime }) => {
    validateSource(bytes, mime);
    const id = crypto.randomUUID();
    const signal = AbortSignal.any([AbortSignal.timeout(22000), ...(config.signal ? [config.signal] : [])]);
    try {
      const text = await send(`/extract/${id}`, mime, bytes, signal);
      if (!text.trim() || text.includes("\0")) throw new Error("extraction_rejected");
      return text;
    } catch {
      // Independent bounded authenticated cancellation, including when the caller's signal is aborted.
      await send(
        `/cancel/${id}`,
        "application/octet-stream",
        new Uint8Array(),
        AbortSignal.timeout(6000),
      ).catch(() => {});
      throw new Error("extraction_rejected");
    }
  };
}
