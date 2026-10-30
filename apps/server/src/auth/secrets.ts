import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Sessions, guests, invites, resets, share links and device codes (04). */
export const randomSecret = () => randomBytes(32).toString("base64url");

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

export const newApiToken = () => `art_${base32(randomBytes(32))}`;

/** `WDJB-MJHT`: 8 characters from an alphabet with no vowels, so a code never spells a word. */
export function newUserCode(): string {
  const bytes = randomBytes(8);
  const letters = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

/** Hashing first gives equal-length buffers, so the compare leaks nothing about length either. */
export const safeEqual = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
