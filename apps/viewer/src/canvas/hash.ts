/** The address fragment for a focused frame. A frame id is whatever the author wrote in data-frame. */
export const frameHash = (key: string) => `frame=${encodeURIComponent(key)}`;

/** The frame a fragment names, or null. Reads what frameHash wrote, and old links with a plain id. */
export function frameFromHash(hash: string): string | null {
  const found = /(?:^#|&)frame=([^&]*)/.exec(hash);
  if (!found) return null;
  try {
    return decodeURIComponent(found[1] as string) || null;
  } catch {
    return null;
  }
}
