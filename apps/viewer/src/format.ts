const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 h ago", "yesterday", "Monday", "Oct 21". */
export function ago(iso: string): string {
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return then.toLocaleDateString(undefined, { weekday: "long" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "CB" for Camera Buddy, "Pe" for Perpetua. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length > 1) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

/** Agents sign with initials in a violet square, never a sparkle. */
export const agentInitials = (agent: string) =>
  /codex/i.test(agent) ? "Cx" : /claude/i.test(agent) ? "Cl" : initials(agent);
export const agentShort = (agent: string) => agent.replace(/ Code$/, "");

export const renderUrl = (artifactId: string, hash: string) => `/api/artifacts/${artifactId}/r/${hash}`;
