import { createHash } from "node:crypto";

/** The same legacy version receives the same ids on reads and on its first draft seed. */
export function legacyBlockIds(versionId: string, pageKey: string) {
  let index = 0;
  return () => {
    const hash = createHash("sha256").update(`${versionId}:${pageKey}:${index++}`).digest("hex");
    return `~${BigInt(`0x${hash}`).toString(36).slice(0, 10)}`;
  };
}
