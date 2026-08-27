import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient, ReferralAttributionStatus, ReferralPointReason, ReferralQualificationKind } from "./generated/prisma/client.js";
import {
  type ReferralCaptureOutcome,
  type ReferralDashboard,
  type ReferralQualificationOutcome,
  type ReferralRepository,
  REFERRAL_QUALIFICATION_KIND,
} from "./referrals.js";

const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LENGTH = 10;
const RECENT_LEDGER_LIMIT = 12;

/** PostgreSQL is the source of truth for attribution and points. Every write
 * that can award points runs in a serializable transaction with database
 * uniqueness constraints as the final replay/race defence. */
export class PrismaReferralRepository implements ReferralRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getDashboard(userId: string): Promise<ReferralDashboard> {
    const code = await this.getOrCreateCode(userId);
    const [invitedCount, qualifiedCount, referralBound, balance, recentEntries] = await Promise.all([
      this.prisma.referralAttribution.count({ where: { referrerUserId: userId } }),
      this.prisma.referralAttribution.count({ where: { referrerUserId: userId, status: ReferralAttributionStatus.QUALIFIED } }),
      this.prisma.referralAttribution.findUnique({
        where: { refereeUserId: userId },
        select: { id: true },
      }).then((attribution) => Boolean(attribution)),
      this.prisma.referralPointsLedger.aggregate({ where: { userId }, _sum: { delta: true } }),
      this.prisma.referralPointsLedger.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: RECENT_LEDGER_LIMIT,
        select: { delta: true, reason: true, createdAt: true },
      }),
    ]);
    return {
      code: code.code,
      totalPoints: balance._sum.delta ?? 0n,
      invitedCount,
      qualifiedCount,
      referralBound,
      recentEntries: recentEntries.map((entry) => ({
        delta: entry.delta,
        reason: entry.reason,
        createdAt: entry.createdAt,
      })),
    };
  }

  async captureAttribution(input: { refereeUserId: string; code: string; now: Date }): Promise<ReferralCaptureOutcome> {
    return this.withSerializableRetry<ReferralCaptureOutcome>(async (transaction) => {
      const existing = await transaction.referralAttribution.findUnique({
        where: { refereeUserId: input.refereeUserId },
        select: { id: true },
      });
      if (existing) {
        return "ALREADY_ATTRIBUTED";
      }
      const referralCode = await transaction.referralCode.findUnique({
        where: { code: input.code },
        select: { id: true, userId: true, revokedAt: true },
      });
      if (!referralCode || referralCode.revokedAt) {
        throw new ReferralRepositoryError("REFERRAL_CODE_INVALID");
      }
      if (referralCode.userId === input.refereeUserId) {
        throw new ReferralRepositoryError("REFERRAL_SELF_NOT_ALLOWED");
      }
      await transaction.referralAttribution.create({
        data: {
          referralCodeId: referralCode.id,
          referrerUserId: referralCode.userId,
          refereeUserId: input.refereeUserId,
          capturedAt: input.now,
        },
      });
      await transaction.auditEvent.create({
        data: {
          userId: input.refereeUserId,
          action: "referral_attributed",
          entityType: "referral_attribution",
          entityId: input.refereeUserId,
        },
      });
      return "CAPTURED";
    }).catch(async (error: unknown): Promise<ReferralCaptureOutcome> => {
      if (error instanceof ReferralRepositoryError) {
        throw error;
      }
      // Two referral tabs can race the database unique index. The winner is
      // retained; the second request is safely idempotent.
      if (isUniqueViolation(error)) {
        const existing = await this.prisma.referralAttribution.findUnique({
          where: { refereeUserId: input.refereeUserId },
          select: { id: true },
        });
        if (existing) {
          return "ALREADY_ATTRIBUTED";
        }
      }
      throw error;
    });
  }

  async qualifyReferral(input: {
    profileUserId: string;
    matchId: string;
    roundId: string;
    sourceEventId: string;
    completedAt: Date;
    referrerPoints: bigint;
    refereePoints: bigint;
  }): Promise<ReferralQualificationOutcome> {
    return this.withSerializableRetry<ReferralQualificationOutcome>(async (transaction) => {
      const seenEvent = await transaction.referralQualification.findUnique({
        where: { sourceEventId: input.sourceEventId },
        select: { id: true },
      });
      if (seenEvent) {
        return "EVENT_ALREADY_PROCESSED";
      }
      const attribution = await transaction.referralAttribution.findUnique({
        where: { refereeUserId: input.profileUserId },
        select: { id: true, referrerUserId: true, status: true },
      });
      if (!attribution) {
        return "NOT_ATTRIBUTED";
      }
      if (attribution.status !== ReferralAttributionStatus.PENDING) {
        return "ALREADY_QUALIFIED";
      }
      const existingQualification = await transaction.referralQualification.findUnique({
        where: {
          refereeUserId_kind: {
            refereeUserId: input.profileUserId,
            kind: ReferralQualificationKind.FREE_ROUND_COMPLETED,
          },
        },
        select: { id: true },
      });
      if (existingQualification) {
        return "ALREADY_QUALIFIED";
      }
      const update = await transaction.referralAttribution.updateMany({
        where: { id: attribution.id, status: ReferralAttributionStatus.PENDING },
        data: { status: ReferralAttributionStatus.QUALIFIED, qualifiedAt: input.completedAt },
      });
      if (update.count !== 1) {
        return "ALREADY_QUALIFIED";
      }
      const qualification = await transaction.referralQualification.create({
        data: {
          attributionId: attribution.id,
          refereeUserId: input.profileUserId,
          kind: ReferralQualificationKind.FREE_ROUND_COMPLETED,
          matchId: input.matchId,
          roundId: input.roundId,
          sourceEventId: input.sourceEventId,
          qualifiedAt: input.completedAt,
        },
      });
      await transaction.referralPointsLedger.createMany({
        data: [
          {
            userId: attribution.referrerUserId,
            delta: input.referrerPoints,
            reason: ReferralPointReason.REFERRER_QUALIFIED_PLAYER,
            referralAttributionId: attribution.id,
            qualificationId: qualification.id,
            idempotencyKey: "referrer-qualified:" + qualification.id,
            metadata: { matchId: input.matchId, roundId: input.roundId },
          },
          {
            userId: input.profileUserId,
            delta: input.refereePoints,
            reason: ReferralPointReason.REFEREE_QUALIFIED_PLAYER,
            referralAttributionId: attribution.id,
            qualificationId: qualification.id,
            idempotencyKey: "referee-qualified:" + qualification.id,
            metadata: { matchId: input.matchId, roundId: input.roundId },
          },
        ],
      });
      await transaction.auditEvent.createMany({
        data: [
          {
            userId: attribution.referrerUserId,
            action: "referral_points_awarded",
            entityType: "referral_qualification",
            entityId: qualification.id,
            metadata: { role: "referrer", points: input.referrerPoints.toString() },
          },
          {
            userId: input.profileUserId,
            action: "referral_points_awarded",
            entityType: "referral_qualification",
            entityId: qualification.id,
            metadata: { role: "referee", points: input.refereePoints.toString() },
          },
        ],
      });
      return "QUALIFIED";
    }).catch((error: unknown): ReferralQualificationOutcome => {
      // A retried request after a completed transaction must be idempotent.
      if (isUniqueViolation(error)) {
        return "EVENT_ALREADY_PROCESSED";
      }
      throw error;
    });
  }

  private async getOrCreateCode(userId: string): Promise<{ code: string }> {
    const existing = await this.prisma.referralCode.findUnique({
      where: { userId },
      select: { code: true, revokedAt: true },
    });
    if (existing && !existing.revokedAt) {
      return { code: existing.code };
    }
    if (existing) {
      // A future administrative revocation may replace a code. Do not revive
      // the same public string, and never silently change an active code.
      return this.replaceRevokedCode(userId);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.prisma.referralCode.create({
          data: { userId, code: createReferralCode() },
          select: { code: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const raced = await this.prisma.referralCode.findUnique({
          where: { userId },
          select: { code: true },
        });
        if (raced) {
          return raced;
        }
      }
    }
    throw new Error("Could not allocate a unique referral code.");
  }

  private async replaceRevokedCode(userId: string): Promise<{ code: string }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.prisma.referralCode.update({
          where: { userId },
          data: { code: createReferralCode(), revokedAt: null },
          select: { code: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    throw new Error("Could not replace a referral code.");
  }

  private async withSerializableRetry<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === 2) {
          throw error;
        }
      }
    }
    throw new Error("Serializable referral transaction exhausted its retry budget.");
  }
}

class ReferralRepositoryError extends Error {
  constructor(readonly code: "REFERRAL_CODE_INVALID" | "REFERRAL_SELF_NOT_ALLOWED") {
    super(code);
  }
}

function createReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += REFERRAL_ALPHABET[byte % REFERRAL_ALPHABET.length];
  }
  return code;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2034";
}
