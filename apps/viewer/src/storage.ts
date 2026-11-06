// Storage throws when a browser blocks site data (Safari with all cookies blocked, some private modes)
// or is full. Reading or remembering something must never be what breaks a screen.

/** `local` lasts on this device; `session` only for this tab. */
type Area = "local" | "session";
const store = (area: Area) => (area === "local" ? localStorage : sessionStorage);

export function readStored(key: string, area: Area = "local"): string | null {
  try {
    return store(area).getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string, area: Area = "local") {
  try {
    store(area).setItem(key, value);
  } catch {}
}

export function forgetStored(key: string, area: Area = "local") {
  try {
    store(area).removeItem(key);
  } catch {}
}
