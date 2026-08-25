import { createHash, randomBytes } from "node:crypto";

const VISITOR_TTL_MS = 75_000;
const MAX_LIVE_VISITORS = 10_000;
const PRESENCE_RATE_WINDOW_MS = 60_000;
const MAX_PRESENCE_REQUESTS_PER_SOURCE = 120;
const WEBSOCKET_UPGRADE_RATE_WINDOW_MS = 10_000;
const MAX_WEBSOCKET_UPGRADES_PER_SOURCE = 60;
const MAX_RATE_LIMIT_SOURCES = 4_096;

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

/**
 * A small process-local abuse brake for the unauthenticated presence endpoint.
 * The rate-limit map contains only a salted one-way fingerprint of the source
 * address, never the address itself, and is discarded when the process exits.
 */
export class PresenceRateLimiter {
  private readonly sources = new Map<string, { windowStartedAt: number; requestCount: number; lastSeenAt: number }>();
  private readonly salt = randomBytes(32);

  constructor(
    private readonly maxRequests = MAX_PRESENCE_REQUESTS_PER_SOURCE,
    private readonly windowMs = PRESENCE_RATE_WINDOW_MS,
  ) {}

  consume(sourceAddress: string | undefined, now = Date.now()): boolean {
    if (!sourceAddress) {
      return false;
    }
    this.prune(now);
    const key = createHash("sha256").update(this.salt).update(sourceAddress).digest("base64url");
    const previous = this.sources.get(key);
    if (!previous || now - previous.windowStartedAt >= this.windowMs) {
      this.enforceCapacity();
      this.sources.set(key, { windowStartedAt: now, requestCount: 1, lastSeenAt: now });
      return true;
    }
    previous.lastSeenAt = now;
    if (previous.requestCount >= this.maxRequests) {
      return false;
    }
    previous.requestCount += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, value] of this.sources) {
      if (now - value.lastSeenAt >= this.windowMs) {
        this.sources.delete(key);
      }
    }
  }

  private enforceCapacity(): void {
    if (this.sources.size < MAX_RATE_LIMIT_SOURCES) {
      return;
    }
    const oldestKey = this.sources.keys().next().value;
    if (oldestKey) {
      this.sources.delete(oldestKey);
    }
  }
}

/**
 * A deliberately bounded, process-local admission brake for a connection
 * attempt. It stores only a salted one-way fingerprint of the source address
 * and expires it quickly. This is not an edge DDoS service, but it stops one
 * source from forcing unlimited matchmaking, room-auth, or upgrade work in a
 * game process while Cloudflare/Railway handle network-layer traffic.
 */
export class WebSocketUpgradeRateLimiter {
  private readonly sources = new Map<string, { windowStartedAt: number; requestCount: number; lastSeenAt: number }>();
  private readonly salt = randomBytes(32);

  constructor(
    private readonly maxRequests = MAX_WEBSOCKET_UPGRADES_PER_SOURCE,
    private readonly windowMs = WEBSOCKET_UPGRADE_RATE_WINDOW_MS,
  ) {}

  consume(sourceAddress: string | undefined, now = Date.now()): boolean {
    if (!sourceAddress) {
      return false;
    }
    this.prune(now);
    const key = createHash("sha256").update(this.salt).update(sourceAddress).digest("base64url");
    const previous = this.sources.get(key);
    if (!previous || now - previous.windowStartedAt >= this.windowMs) {
      this.enforceCapacity();
      this.sources.set(key, { windowStartedAt: now, requestCount: 1, lastSeenAt: now });
      return true;
    }
    previous.lastSeenAt = now;
    if (previous.requestCount >= this.maxRequests) {
      return false;
    }
    previous.requestCount += 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, value] of this.sources) {
      if (now - value.lastSeenAt >= this.windowMs) {
        this.sources.delete(key);
      }
    }
  }

  private enforceCapacity(): void {
    if (this.sources.size < MAX_RATE_LIMIT_SOURCES) {
      return;
    }
    const oldestKey = this.sources.keys().next().value;
    if (oldestKey) {
      this.sources.delete(oldestKey);
    }
  }
}
