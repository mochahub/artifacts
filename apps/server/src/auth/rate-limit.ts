import type { Clock } from "../clock.ts";
import { ApiError } from "../http/errors.ts";

const FIFTEEN_MINUTES = 15 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_KEYS = 50_000;

const limited = (retryAfterMs: number) =>
  new ApiError("rate_limited", "Too many attempts. Try again later.", {
    retryAfter: Math.ceil(retryAfterMs / 1000),
  });

/** In memory, per process (04, "Rate limits"). With several replicas, limits are per replica. */
export class RateLimits {
  private readonly hits = new Map<string, number[]>();
  private readonly accountFailures = new Map<string, number[]>();
  private readonly budgets = new Map<string, { start: number; used: number }>();

  constructor(private readonly clock: Clock) {}

  private recent(map: Map<string, number[]>, key: string, windowMs: number): number[] {
    const since = this.clock.now().getTime() - windowMs;
    const kept = (map.get(key) ?? []).filter((at) => at > since);
    if (kept.length > 0) map.set(key, kept);
    else map.delete(key);
    return kept;
  }

  /** Keys only shrink when hit again, so random ones would otherwise pile up forever. */
  private sweep(now: number) {
    for (const map of [this.hits, this.accountFailures]) {
      if (map.size < MAX_KEYS) continue;
      for (const [key, times] of map) if ((times.at(-1) ?? 0) < now - 2 * HOUR) map.delete(key);
      // Still full of live keys: drop the oldest tenth, so flooding can't also wipe everyone's limits.
      for (const key of map.keys()) {
        if (map.size < MAX_KEYS * 0.9) break;
        map.delete(key);
      }
    }
  }

  /** Counts one attempt; throws 429 past `limit` in `windowMs`. */
  hit(key: string, limit: number, windowMs: number) {
    this.sweep(this.clock.now().getTime());
    const kept = this.recent(this.hits, key, windowMs);
    const now = this.clock.now().getTime();
    if (kept.length >= limit) throw limited((kept[0] as number) + windowMs - now);
    kept.push(now);
    this.hits.set(key, kept);
  }

  /** Takes `amount` from a budget that refills every `windowMs`; false when it would go over. */
  spend(key: string, amount: number, limit: number, windowMs: number) {
    const now = this.clock.now().getTime();
    const budget = this.budgets.get(key);
    const current = budget && now - budget.start < windowMs ? budget : { start: now, used: 0 };
    this.budgets.set(key, current);
    if (current.used + amount > limit) return false;
    current.used += amount;
    return true;
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
    this.sweep(this.clock.now().getTime());
    const failures = this.recent(this.accountFailures, email, HOUR + FIFTEEN_MINUTES);
    failures.push(this.clock.now().getTime());
    this.accountFailures.set(email, failures);
  }

  passwordOk(email: string) {
    this.accountFailures.delete(email);
  }
}
