import { createCipheriv, createECDH, createPrivateKey, createSign, hkdfSync, randomBytes } from "node:crypto";

const CURVE = "prime256v1";
const b64 = (value: Uint8Array | string) => Buffer.from(value).toString("base64url");
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array | string, length: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** Both as base64url: the public key as an uncompressed point, the private key as raw bytes. */
export function generateVapid() {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

/** RFC 8292: a short-lived ES256 token naming the push service it's for. */
export function vapidHeader(
  audience: string,
  subject: string,
  keys: { publicKey: string; privateKey: string },
  now: Date,
) {
  const point = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64(point.subarray(1, 33)),
      y: b64(point.subarray(33, 65)),
      d: keys.privateKey,
    },
  });
  const claims = { aud: audience, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${b64(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64(JSON.stringify(claims))}`;
  const signature = createSign("sha256").update(unsigned).sign({ key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

/** RFC 8291's aes128gcm: only the browser that subscribed can read a payload, not the push service. */
export function encryptPayload(plaintext: string, keys: { p256dh: string; auth: string }) {
  const receiver = Buffer.from(keys.p256dh, "base64url");
  const auth = Buffer.from(keys.auth, "base64url");
  const sender = createECDH(CURVE);
  const senderPublic = sender.generateKeys();
  const shared = sender.computeSecret(receiver);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, senderPublic]);
  const ikm = hkdf(shared, auth, info, 32);
  const salt = randomBytes(16);
  const cek = hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body, cipher.getAuthTag()]);
}
