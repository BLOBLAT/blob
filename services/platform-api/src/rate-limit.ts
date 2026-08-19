export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * A deliberately small, bounded, process-local brake for public auth routes.
 * It does not replace an edge/WAF limit, but it prevents one process from
 * repeatedly writing challenges or performing signature verification for the
 * same wallet while the platform is still single-replica.
 */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries = 10_000
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("Rate limiter configuration must contain positive safe integers.");
    }
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const existing = this.entries.get(key);
    if (existing && existing.resetAt > now) {
      if (existing.count >= this.limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1_000)) };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.prune(now);
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestResetAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.resetAt < oldestResetAt) {
          oldestKey = key;
          oldestResetAt = entry.resetAt;
        }
      }
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}
