/**
 * Referral points are deliberately kept outside wallet, token, and game-core
 * code. The platform service owns attribution and its immutable point ledger;
 * the browser can only read its own data and submit an optional code.
 */

export const REFERRAL_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;
export const REFERRAL_QUALIFICATION_KIND = "FREE_ROUND_COMPLETED" as const;

export type ReferralQualificationKind = typeof REFERRAL_QUALIFICATION_KIND;

export interface ReferralDashboard {
  code: string;
  totalPoints: bigint;
  invitedCount: number;
  qualifiedCount: number;
  referralBound: boolean;
  recentEntries: Array<{
    delta: bigint;
    reason: "REFERRER_QUALIFIED_PLAYER" | "REFEREE_QUALIFIED_PLAYER" | "ADMIN_ADJUSTMENT";
    createdAt: Date;
  }>;
}

export type ReferralCaptureOutcome = "CAPTURED" | "ALREADY_ATTRIBUTED";
export type ReferralQualificationOutcome =
  | "QUALIFIED"
  | "NOT_ATTRIBUTED"
  | "ALREADY_QUALIFIED"
  | "EVENT_ALREADY_PROCESSED"
  | "INSUFFICIENT_GAMEPLAY"
  | "DAILY_CAP_REACHED";

export interface ReferralProgramRules {
  /** A link may only bind to a newly created BLOB profile. */
  attributionWindowMs: number;
  /** Activity comes solely from the final server-authoritative arena result. */
  minFoodCollected: number;
  minSurvivalTimeMs: number;
  /** Durable UTC-day ceiling per referrer; it is not a browser counter. */
  maxQualificationsPerReferrerPerDay: number;
}

export interface ReferralRepository {
  getDashboard(userId: string): Promise<ReferralDashboard>;
  captureAttribution(input: {
    refereeUserId: string;
    code: string;
    now: Date;
    attributionWindowMs: number;
  }): Promise<ReferralCaptureOutcome>;
  qualifyReferral(input: {
    profileUserId: string;
    matchId: string;
    roundId: string;
    sourceEventId: string;
    completedAt: Date;
    foodCollected: number;
    survivalTimeMs: number;
    referrerPoints: bigint;
    refereePoints: bigint;
    maxQualificationsPerReferrerPerDay: number;
  }): Promise<ReferralQualificationOutcome>;
}

export class ReferralError extends Error {
  constructor(readonly code: "REFERRAL_CODE_INVALID" | "REFERRAL_SELF_NOT_ALLOWED" | "REFERRAL_ATTRIBUTION_WINDOW_CLOSED", message: string) {
    super(message);
  }
}

export class ReferralService {
  constructor(
    private readonly repository: ReferralRepository,
    private readonly points: { referrer: bigint; referee: bigint },
    private readonly rules: ReferralProgramRules,
  ) {}

  async getDashboard(userId: string): Promise<ReferralDashboard> {
    return this.repository.getDashboard(userId);
  }

  async captureAttribution(input: { refereeUserId: string; code: string; now?: Date }): Promise<ReferralCaptureOutcome> {
    const code = input.code.trim().toUpperCase();
    if (!REFERRAL_CODE_PATTERN.test(code)) {
      throw new ReferralError("REFERRAL_CODE_INVALID", "That referral link is not valid.");
    }
    try {
      return await this.repository.captureAttribution({
        refereeUserId: input.refereeUserId,
        code,
        now: input.now ?? new Date(),
        attributionWindowMs: this.rules.attributionWindowMs,
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const errorCode = (error as { code?: unknown }).code;
        if (errorCode === "REFERRAL_CODE_INVALID") {
          throw new ReferralError("REFERRAL_CODE_INVALID", "That referral link is not valid.");
        }
        if (errorCode === "REFERRAL_SELF_NOT_ALLOWED") {
          throw new ReferralError("REFERRAL_SELF_NOT_ALLOWED", "You cannot use your own referral link.");
        }
        if (errorCode === "REFERRAL_ATTRIBUTION_WINDOW_CLOSED") {
          throw new ReferralError("REFERRAL_ATTRIBUTION_WINDOW_CLOSED", "Referral links can only be attached to a new BLOB profile.");
        }
      }
      throw error;
    }
  }

  async qualify(input: {
    profileUserId: string;
    matchId: string;
    roundId: string;
    sourceEventId: string;
    completedAt: Date;
    foodCollected: number;
    survivalTimeMs: number;
  }): Promise<ReferralQualificationOutcome> {
    if (input.foodCollected < this.rules.minFoodCollected || input.survivalTimeMs < this.rules.minSurvivalTimeMs) {
      return "INSUFFICIENT_GAMEPLAY";
    }
    return this.repository.qualifyReferral({
      ...input,
      referrerPoints: this.points.referrer,
      refereePoints: this.points.referee,
      maxQualificationsPerReferrerPerDay: this.rules.maxQualificationsPerReferrerPerDay,
    });
  }
}
