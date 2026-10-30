export type Quote = { exact: string; prefix?: string; suffix?: string };

/**
 * Where a quoted passage sits in a block's text, as `[start, end)` into that text.
 *
 * The quote was taken from a selection, so its whitespace is collapsed (the browser shows a line break
 * in the source as one space), while the block's text still has the line breaks and runs of spaces from
 * the HTML. Matching on the collapsed text and mapping back finds a passage that spans a line. When the
 * words occur more than once, the occurrence whose surroundings match the quote's prefix and suffix wins,
 * and the first one is the fallback.
 */
export function findQuote(text: string, quote: Quote): [number, number] | null {
  const exact = quote.exact.replace(/\s+/g, " ").trim();
  if (!exact) return null;

  let flat = "";
  const origin: number[] = []; // origin[i] is where flat[i] came from in `text`
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (/\s/.test(char)) {
      if (flat === "" || flat.endsWith(" ")) continue;
      flat += " ";
    } else {
      flat += char;
    }
    origin.push(i);
  }

  const prefix = (quote.prefix ?? "").replace(/\s+/g, " ").trimStart();
  const suffix = (quote.suffix ?? "").replace(/\s+/g, " ").trimEnd();
  let best = -1;
  let bestScore = -1;
  for (let at = flat.indexOf(exact); at >= 0; at = flat.indexOf(exact, at + 1)) {
    const score =
      (prefix && flat.slice(0, at).endsWith(prefix) ? 1 : 0) +
      (suffix && flat.slice(at + exact.length).startsWith(suffix) ? 1 : 0);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  if (best < 0) return null;
  return [origin[best] as number, (origin[best + exact.length - 1] as number) + 1];
}
