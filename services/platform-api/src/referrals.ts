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
export type ReferralQualificationOutcome = "QUALIFIED" | "NOT_ATTRIBUTED" | "ALREADY_QUALIFIED" | "EVENT_ALREADY_PROCESSED";

export interface ReferralRepository {
  getDashboard(userId: string): Promise<ReferralDashboard>;
  captureAttribution(input: { refereeUserId: string; code: string; now: Date }): Promise<ReferralCaptureOutcome>;
  qualifyReferral(input: {
    profileUserId: string;
    matchId: string;
    roundId: string;
    sourceEventId: string;
    completedAt: Date;
    referrerPoints: bigint;
    refereePoints: bigint;
  }): Promise<ReferralQualificationOutcome>;
}

export class ReferralError extends Error {
  constructor(readonly code: "REFERRAL_CODE_INVALID" | "REFERRAL_SELF_NOT_ALLOWED", message: string) {
    super(message);
  }
}

export class ReferralService {
  constructor(
    private readonly repository: ReferralRepository,
    private readonly points: { referrer: bigint; referee: bigint },
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
  }): Promise<ReferralQualificationOutcome> {
    return this.repository.qualifyReferral({
      ...input,
      referrerPoints: this.points.referrer,
      refereePoints: this.points.referee,
    });
  }
}
