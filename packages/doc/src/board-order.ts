import { BOARD_ORDER_MAX } from "@artifacts/schema/constants";

/**
 * Fractional z-order keys (14, "Z-order and containment"): base-62 digits `0-9A-Za-z`, an integer head
 * whose first character says its length, then a fractional tail that never ends in `0`. The first key is
 * `a0`. Keys compare by code point, never by locale; equal keys from concurrent writers tie-break by id.
 */
export const ORDER_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = ORDER_DIGITS[0] as string;
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;
export const FIRST_ORDER = "a0";

const digit = (char: string) => ORDER_DIGITS.indexOf(char);

/** Code-point comparison, as JS `<` does for strings of this alphabet. */
export const compareOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Siblings draw in `(order, id)` order. */
export const compareSiblings = (a: { order: string; id: string }, b: { order: string; id: string }) =>
  compareOrder(a.order, b.order) || compareOrder(a.id, b.id);

function integerLength(head: string): number | null {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  return null;
}

function integerPart(key: string): string | null {
  const length = integerLength(key[0] ?? "");
  if (length === null || length > key.length) return null;
  return key.slice(0, length);
}

/** Whether a key is canonical: alphabet, length, a valid head and no trailing zero in its tail. */
export function isOrderKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > BOARD_ORDER_MAX) return false;
  for (const char of key) if (digit(char) < 0) return false;
  if (key === SMALLEST_INTEGER) return false;
  const int = integerPart(key);
  if (int === null) return false;
  const fraction = key.slice(int.length);
  return !fraction.endsWith(ZERO);
}

/** A digit string strictly between a and b (b may be null for "no upper bound"); a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith(ZERO) || b?.endsWith(ZERO)) throw new Error("trailing zero");
  if (b) {
    // Shared prefix first.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0] as string) : 0;
  const db = b !== null ? digit(b[0] as string) : ORDER_DIGITS.length;
  if (db - da > 1) return ORDER_DIGITS[Math.round(0.5 * (da + db))] as string;
  // The digits are consecutive.
  if (b && b.length > 1) return b.slice(0, 1);
  return (ORDER_DIGITS[da] as string) + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const [head, ...rest] = x.split("") as [string, ...string[]];
  let carry = true;
  for (let i = rest.length - 1; carry && i >= 0; i--) {
    const d = digit(rest[i] as string) + 1;
    if (d === ORDER_DIGITS.length) rest[i] = ZERO;
    else {
      rest[i] = ORDER_DIGITS[d] as string;
      carry = false;
    }
  }
  if (!carry) return head + rest.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") rest.push(ZERO);
  else rest.pop();
  return next + rest.join("");
}

function decrementInteger(x: string): string | null {
  const [head, ...rest] = x.split("") as [string, ...string[]];
  let borrow = true;
  const last = ORDER_DIGITS[ORDER_DIGITS.length - 1] as string;
  for (let i = rest.length - 1; borrow && i >= 0; i--) {
    const d = digit(rest[i] as string) - 1;
    if (d === -1) rest[i] = last;
    else {
      rest[i] = ORDER_DIGITS[d] as string;
      borrow = false;
    }
  }
  if (!borrow) return head + rest.join("");
  if (head === "a") return `Z${last}`;
  if (head === "A") return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < "Z") rest.push(last);
  else rest.pop();
  return next + rest.join("");
}

/**
 * A key strictly between `a` and `b` (null: no bound on that side). Throws when the keys are invalid
 * or out of order. The result may exceed 64 characters only after a long run of insertions into one
 * gap; `orderBetween` refuses that, and the server rebalances (`rebalanceOrders`).
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isOrderKey(a)) throw new Error(`invalid order key ${a}`);
  if (b !== null && !isOrderKey(b)) throw new Error(`invalid order key ${b}`);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return FIRST_ORDER;
    const ib = integerPart(b) as string;
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error("cannot decrement any more");
    return res;
  }
  if (b === null) {
    const ia = integerPart(a) as string;
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a) as string;
  const fa = a.slice(ia.length);
  const ib = integerPart(b) as string;
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** `n` ascending keys between `a` and `b`, spread evenly enough for seeding. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const out: string[] = [];
    let at = a;
    for (let i = 0; i < n; i++) {
      at = keyBetween(at, null);
      out.push(at);
    }
    return out;
  }
  if (a === null) {
    const out: string[] = [];
    let at = b;
    for (let i = 0; i < n; i++) {
      at = keyBetween(null, at);
      out.push(at);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/** A key between neighbours, or null when it would pass `BOARD_ORDER_MAX` (time to rebalance). */
export function orderBetween(a: string | null, b: string | null): string | null {
  const key = keyBetween(a, b);
  return key.length <= BOARD_ORDER_MAX ? key : null;
}

/** Fresh evenly spaced keys for siblings, preserving their current `(order, id)` order. */
export function rebalanceOrders(siblings: { id: string; order: string }[]): Map<string, string> {
  const sorted = [...siblings].sort(compareSiblings);
  const keys = keysBetween(null, null, sorted.length);
  return new Map(sorted.map((sibling, index) => [sibling.id, keys[index] as string]));
}
