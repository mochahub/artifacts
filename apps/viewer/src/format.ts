const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * "2 h ago", "yesterday", "Monday", "Oct 21", "Oct 21, 2025". Past a day, it counts calendar days in
 * the reader's time zone: 26 hours ago on Wednesday at 1 am is Monday, not yesterday.
 */
export function ago(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = now - then.getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(then)) / DAY);
  if (days <= 1) return "yesterday";
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
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
  /codex/i.test(agent) ? "Cx" : /claude/i.test(agent) ? "Cl" : /agent$/i.test(agent) ? "Ag" : initials(agent);
export const agentShort = (agent: string) => agent.replace(/ Code$/, "");

export const renderUrl = (artifactId: string, hash: string) => `/api/artifacts/${artifactId}/r/${hash}`;
