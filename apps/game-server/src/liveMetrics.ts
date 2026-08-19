const VISITOR_TTL_MS = 75_000;
const MAX_LIVE_VISITORS = 10_000;

export interface LiveMetricsSnapshot {
  liveVisitors: number;
  arenaPlayers: number;
}

/**
 * Ephemeral, privacy-minimal presence used only for the public landing-page
 * counter. It stores no account, wallet, IP address, user agent, or history.
 */
export class LiveMetrics {
  private readonly visitors = new Map<string, number>();
  private readonly arenaSessions = new Set<string>();

  recordVisitor(visitorId: string, now = Date.now()): LiveMetricsSnapshot {
    this.pruneVisitors(now);
    if (!this.visitors.has(visitorId) && this.visitors.size >= MAX_LIVE_VISITORS) {
      const oldestVisitor = this.visitors.keys().next().value;
      if (oldestVisitor) {
        this.visitors.delete(oldestVisitor);
      }
    }
    this.visitors.delete(visitorId);
    this.visitors.set(visitorId, now);
    return this.snapshot(now);
  }

  recordArenaJoin(sessionId: string): void {
    this.arenaSessions.add(sessionId);
  }

  recordArenaLeave(sessionId: string): void {
    this.arenaSessions.delete(sessionId);
  }

  snapshot(now = Date.now()): LiveMetricsSnapshot {
    this.pruneVisitors(now);
    return {
      liveVisitors: this.visitors.size,
      arenaPlayers: this.arenaSessions.size,
    };
  }

  private pruneVisitors(now: number): void {
    for (const [visitorId, lastSeenAt] of this.visitors) {
      if (now - lastSeenAt > VISITOR_TTL_MS) {
        this.visitors.delete(visitorId);
      }
    }
  }
}

export function isValidVisitorId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}
