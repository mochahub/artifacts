import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const METADATA_TIMEOUT_MS = 5000;
const METADATA_MAX_BYTES = 64 * 1024;

/** Addresses a metadata URL must never reach: this server, its neighbours and cloud metadata. */
export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  if (isIP(mapped) === 4) {
    const [a = 0, b = 0] = mapped.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    mapped === "::" ||
    mapped === "::1" ||
    mapped.startsWith("fc") ||
    mapped.startsWith("fd") ||
    mapped.startsWith("fe8") ||
    mapped.startsWith("fe9") ||
    mapped.startsWith("fea") ||
    mapped.startsWith("feb") ||
    mapped.startsWith("ff")
  );
}

export type MetadataFetch = (url: URL) => Promise<unknown>;

/**
 * SSRF is the risk here: an unauthenticated caller chooses the URL. So it's https to a public address,
 * no redirects, a short timeout and a small answer. A name could still resolve differently a moment
 * later for the fetch itself, which Bun gives no way to pin; the answer isn't shown to the caller,
 * which is what keeps that from being a way to read internal services.
 */
export async function fetchMetadata(url: URL): Promise<unknown> {
  const addresses = isIP(url.hostname.replace(/^\[|\]$/g, ""))
    ? [{ address: url.hostname.replace(/^\[|\]$/g, "") }]
    : await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("private address");
  }
  const response = await fetch(url, {
    redirect: "error",
    credentials: "omit",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > METADATA_MAX_BYTES) throw new Error("too big");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
