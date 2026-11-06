import { DAY_MS, HOUR_MS, MINUTE_MS } from "@artifacts/schema/constants";

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** A date as the reader says it: "Monday", "Oct 21", or "Oct 21, 2025" outside this year. */
function day(then: Date, now: number, days: number) {
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

const calendarDays = (from: Date, to: Date) => Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);

/**
 * "2 h ago", "yesterday", "Monday", "Oct 21", "Oct 21, 2025". Past a day, it counts calendar days in
 * the reader's time zone: 26 hours ago on Wednesday at 1 am is Monday, not yesterday.
 */
export function ago(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = now - then.getTime();
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} h ago`;
  const days = calendarDays(then, new Date(now));
  return days <= 1 ? "yesterday" : day(then, now, days);
}

/** The other way: "in 20 min", "in 5 h", "tomorrow", "Monday", "Oct 21". For when something ends. */
export function until(iso: string, now = Date.now()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = then.getTime() - now;
  if (diff < MINUTE_MS) return "now";
  if (diff < HOUR_MS) return `in ${Math.floor(diff / MINUTE_MS)} min`;
  if (diff < DAY_MS) return `in ${Math.floor(diff / HOUR_MS)} h`;
  const days = calendarDays(new Date(now), then);
  return days <= 1 ? "tomorrow" : day(then, now, days);
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

export const agentShort = (agent: string) => agent.replace(/ Code$/, "");

/** "Member" for member: a role or a level, as a label. */
export const capitalize = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
