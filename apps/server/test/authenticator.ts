import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest();
const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64url");

/** Just enough CBOR for a COSE key and a `none` attestation object. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string")
    return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value] : Object.entries(value as object);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

/** A software passkey, so API tests can do what no browser would: skip verification, replay, lie. */
export function softAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(16);
  let counter = 0;

  const flags = (uv: boolean, attested: boolean) => 0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0);
  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const authData = (rpId: string, uv: boolean, attested?: Buffer) => {
    counter += 1;
    const bytes = Buffer.alloc(37);
    sha(rpId).copy(bytes);
    bytes[32] = flags(uv, attested !== undefined);
    bytes.writeUInt32BE(counter, 33);
    return attested ? Buffer.concat([bytes, attested]) : bytes;
  };

  return {
    id: b64(id),
    register(options: { rp: { id: string }; challenge: string }, origin: string, uv = true) {
      const cose = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x as string, "base64url")],
          [-3, Buffer.from(jwk.y as string, "base64url")],
        ]),
      );
      const length = Buffer.from([0, id.length]);
      const attested = Buffer.concat([Buffer.alloc(16), length, id, cose]);
      const data = authData(options.rp.id, uv, attested);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: b64(cbor({ fmt: "none", attStmt: {}, authData: data })),
          transports: ["internal"],
        },
      };
    },
    assert(options: { rpId: string; challenge: string }, origin: string, uv = true) {
      const data = authData(options.rpId, uv);
      const client = clientData("webauthn.get", options.challenge, origin);
      const signature = createSign("sha256")
        .update(Buffer.concat([data, sha(client)]))
        .sign(privateKey);
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(client),
          authenticatorData: b64(data),
          signature: b64(signature),
        },
      };
    },
  };
}
