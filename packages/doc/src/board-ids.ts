import { BLOCK_ID_PATTERN } from "@artifacts/schema/constants";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A lasting id: `~` and ten base-36 characters (`BLOCK_ID_PATTERN`). Shared by article blocks and board
 * objects (14, "Objects and stable ids"), without the article id plugin's ProseMirror imports.
 */
export function mintLastingId(): string {
  let id = "~";
  while (id.length < 11) {
    // Bytes of 252 and up are drawn again: 252 is the largest multiple of 36 under 256, so no
    // character is likelier than another.
    for (const byte of crypto.getRandomValues(new Uint8Array(16)))
      if (byte < 252 && id.length < 11) id += ALPHABET[byte % 36];
  }
  return id;
}

/** A new board object's id. The server mints seed/agent ids; a browser mints its person's new objects. */
export const mintBoardObjectId = mintLastingId;

export const isBoardObjectId = (value: unknown): value is string =>
  typeof value === "string" && BLOCK_ID_PATTERN.test(value);

/** A fresh id not in `taken` (active, deleted or reserved), retried before insertion. */
export function mintFreshBoardObjectId(taken: (id: string) => boolean, mint = mintBoardObjectId): string {
  for (let i = 0; i < 100; i++) {
    const id = mint();
    if (!taken(id)) return id;
  }
  throw new Error("couldn't mint a fresh board object id");
}
