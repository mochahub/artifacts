import { createHmac, hkdfSync } from "node:crypto";
import { safeEqual } from "./secrets.ts";

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

const keyFor = (secret: string, info: string) => Buffer.from(hkdfSync("sha256", secret, "", info, 32));

/** `base64url(payload).base64url(HMAC)` (04). `info` keeps content tokens and upload ids apart. */
export function signPayload(payload: unknown, secret: string, info: string): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac("sha256", keyFor(secret, info)).update(body).digest())}`;
}

export function verifyPayload<T>(token: string, secret: string, info: string): T | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = b64(createHmac("sha256", keyFor(secret, info)).update(body).digest());
  if (!safeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}
