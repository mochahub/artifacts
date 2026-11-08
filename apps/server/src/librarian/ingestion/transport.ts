import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

const MAX = 5 * 1024 * 1024;
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only currently allocated global unicast; reject mapped, compatible, transition and special ranges.
  if (isIP(address) !== 6) return false;
  const parts = address.toLowerCase().split(":");
  const first = Number.parseInt(parts[0] ?? "", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !address.includes(".") &&
    first !== 0x2001 &&
    first !== 0x2002 &&
    first !== 0x3fff
  );
}
export function sourceUrl(value: string): URL {
  if (value.length > 2048) throw new Error("source_url_rejected");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    isIP(u.hostname) ||
    u.hostname.includes(":") ||
    u.hostname.endsWith(".")
  )
    throw new Error("source_url_rejected");
  return u;
}
export function responseMime(
  status: number | undefined,
  headers: { "content-type"?: string; "content-encoding"?: string; "content-length"?: string },
): string {
  const mime = (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    status !== 200 ||
    !["text/plain", "text/markdown", "text/html"].includes(mime) ||
    (headers["content-encoding"] && headers["content-encoding"] !== "identity") ||
    (headers["content-length"] !== undefined &&
      (!/^\d+$/.test(headers["content-length"]) || Number(headers["content-length"]) > MAX))
  )
    throw new Error("source_response_rejected");
  return mime;
}
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export async function pinnedAddresses(
  host: string,
  resolve: Resolver,
): Promise<{ address: string; family: number }[]> {
  const addresses = await resolve(host);
  if (
    !addresses.length ||
    addresses.length > 64 ||
    addresses.some((a) => !publicAddress(a.address) || isIP(a.address) !== a.family)
  )
    throw new Error("source_destination_rejected");
  return addresses;
}
/** No retries, proxy discovery, redirects or ambient headers. TLS still authenticates the original hostname. */
export const fetchPublicSource = sourceTransport();
/** Trusted construction seam for controlled socket fixtures; never request-selected. */
export function sourceTransport(
  resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
  httpsRequest: typeof request = request,
): (value: string) => Promise<{ bytes: Uint8Array; mime: string }> {
  return async (value) => {
    const url = sourceUrl(value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const addresses = await Promise.race([
        pinnedAddresses(url.hostname, resolver),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("source_timeout")), {
            once: true,
          }),
        ),
      ]);
      const pinned = addresses[0];
      if (!pinned || controller.signal.aborted) throw new Error("source_timeout");
      return await new Promise((resolve, reject) => {
        const req = httpsRequest(
          url,
          {
            method: "GET",
            agent: false,
            family: pinned.family,
            signal: controller.signal,
            servername: url.hostname,
            rejectUnauthorized: true,
            headers: { Accept: "text/plain, text/markdown, text/html", "Accept-Encoding": "identity" },
            lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
          },
          (res) => {
            let mime: string;
            try {
              mime = responseMime(res.statusCode, res.headers);
            } catch {
              res.destroy();
              reject(new Error("source_response_rejected"));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX) {
                res.destroy();
                reject(new Error("source_too_large"));
              } else chunks.push(chunk);
            });
            res.on("error", () => reject(new Error("source_transport_failed")));
            res.on("end", () => resolve({ bytes: Buffer.concat(chunks), mime }));
          },
        );
        req.on("error", () => reject(new Error("source_transport_failed")));
        req.end();
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}
