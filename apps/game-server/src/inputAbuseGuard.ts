import { ArenaInputRejectionReason, type ArenaInputRejectionReason as ArenaInputRejectionReasonType } from "@blob/game-core";

export const INPUT_ABUSE_WINDOW_MS = 10_000;
export const MAX_INVALID_INPUTS_PER_WINDOW = 5;
export const MAX_RATE_LIMITED_INPUTS_PER_WINDOW = 100;
const MAX_TRACKED_IDENTITIES = 512;

export interface InputAbuseDecision {
  disconnect: boolean;
  count: number;
  category: "INVALID" | "RATE";
}

interface InputWindow {
  invalidAt: number[];
  rateLimitedAt: number[];
  lastSeenAt: number;
}

/**
 * Bounded, in-memory escalation for clear input abuse. It intentionally does
 * not inspect raw payloads or retain IP/wallet data. Normal phase changes,
 * deaths, and released controls are not violations. A rate limit requires a
 * much higher threshold than malformed data so a struggling browser is not
 * punished for a transient burst.
 */
export class InputAbuseGuard {
  private readonly windows = new Map<string, InputWindow>();

  recordMalformed(identityKey: string, now: number): InputAbuseDecision {
    return this.record(identityKey, "INVALID", now);
  }

  recordSimulationRejection(identityKey: string, reason: ArenaInputRejectionReasonType, now: number): InputAbuseDecision | undefined {
    if (reason === ArenaInputRejectionReason.INVALID_VECTOR || reason === ArenaInputRejectionReason.INVALID_TIMESTAMP) {
      return this.record(identityKey, "INVALID", now);
    }
    if (reason === ArenaInputRejectionReason.RATE_LIMITED) {
      return this.record(identityKey, "RATE", now);
    }
    return undefined;
  }

  private record(identityKey: string, category: "INVALID" | "RATE", now: number): InputAbuseDecision {
    const safeNow = Number.isFinite(now) ? now : Date.now();
    this.prune(safeNow);
    const window = this.windows.get(identityKey) ?? { invalidAt: [], rateLimitedAt: [], lastSeenAt: safeNow };
    const events = category === "INVALID" ? window.invalidAt : window.rateLimitedAt;
    events.push(safeNow);
    window.lastSeenAt = safeNow;
    this.windows.set(identityKey, window);
    const limit = category === "INVALID" ? MAX_INVALID_INPUTS_PER_WINDOW : MAX_RATE_LIMITED_INPUTS_PER_WINDOW;
    return { category, count: events.length, disconnect: events.length >= limit };
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      window.invalidAt = window.invalidAt.filter((seenAt) => now - seenAt < INPUT_ABUSE_WINDOW_MS);
      window.rateLimitedAt = window.rateLimitedAt.filter((seenAt) => now - seenAt < INPUT_ABUSE_WINDOW_MS);
      if (window.invalidAt.length === 0 && window.rateLimitedAt.length === 0 && now - window.lastSeenAt >= INPUT_ABUSE_WINDOW_MS) {
        this.windows.delete(key);
      }
    }
    while (this.windows.size >= MAX_TRACKED_IDENTITIES) {
      const oldest = this.windows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.windows.delete(oldest);
    }
  }
}
