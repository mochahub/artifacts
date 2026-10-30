import type { Clock } from "../clock.ts";
import { ApiError } from "../http/errors.ts";

const FIFTEEN_MINUTES = 15 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const limited = (retryAfterMs: number) =>
  new ApiError("rate_limited", "Too many attempts. Try again later.", {
    retryAfter: Math.ceil(retryAfterMs / 1000),
  });

/** In memory, per process (04, "Rate limits"). With several replicas, limits are per replica. */
export class RateLimits {
  private readonly hits = new Map<string, number[]>();
  private readonly accountFailures = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  private recent(map: Map<string, number[]>, key: string, windowMs: number): number[] {
    const since = this.clock.now().getTime() - windowMs;
    const kept = (map.get(key) ?? []).filter((at) => at > since);
    if (kept.length > 0) map.set(key, kept);
    else map.delete(key);
    return kept;
  }

  /** Counts one attempt; throws 429 past `limit` in `windowMs`. */
  hit(key: string, limit: number, windowMs: number) {
    const kept = this.recent(this.hits, key, windowMs);
    const now = this.clock.now().getTime();
    if (kept.length >= limit) throw limited((kept[0] as number) + windowMs - now);
    kept.push(now);
    this.hits.set(key, kept);
  }

  /** 5 failures per account per 15 minutes, then 1 attempt a minute, doubling to an hour (04). */
  checkPassword(email: string, ip: string) {
    this.hit(`password-ip:${ip}`, 30, FIFTEEN_MINUTES);
    const failures = this.recent(this.accountFailures, email, HOUR + FIFTEEN_MINUTES);
    const over = failures.length - 4;
    if (over <= 0) return;
    const wait = Math.min(MINUTE * 2 ** (over - 1), HOUR);
    const until = (failures.at(-1) as number) + wait;
    const now = this.clock.now().getTime();
    if (now < until) throw limited(until - now);
  }

  passwordFailed(email: string) {
    const failures = this.recent(this.accountFailures, email, HOUR + FIFTEEN_MINUTES);
    failures.push(this.clock.now().getTime());
    this.accountFailures.set(email, failures);
  }

  passwordOk(email: string) {
    this.accountFailures.delete(email);
  }
}
