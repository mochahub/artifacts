// localStorage throws when a browser blocks site data (Safari with all cookies blocked, some private
// modes) or is full. Reading or remembering a preference must never be what breaks a screen.
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
