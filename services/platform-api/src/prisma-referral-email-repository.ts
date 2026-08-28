import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import {
  ReferralEmailRepositoryError,
  type ReferralEmailRepository,
  type ReferralEmailVerificationState,
  type ReferralEmailVerificationStatus,
} from "./referral-email.js";

type EmailVerificationRow = {
  id: string;
  userId: string;
  emailHash: string;
  encryptedEmail: string | null;
  verificationCodeHash: string | null;
  verificationExpiresAt: Date | null;
  failedAttempts: number;
  lastSentAt: Date | null;
  privacyNoticeVersion: string;
  verifiedAt: Date | null;
};

/** PostgreSQL is the privacy-preserving source of referral email state. */
export class PrismaReferralEmailRepository implements ReferralEmailRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getStatus(userId: string, now: Date): Promise<ReferralEmailVerificationStatus> {
    const record = await this.prisma.referralEmailVerification.findUnique({
      where: { userId },
      select: { verifiedAt: true, verificationExpiresAt: true, privacyNoticeVersion: true },
    });
    if (!record) {
      return { state: "NOT_STARTED", expiresAt: null, privacyNoticeVersion: null };
    }
    if (record.verifiedAt) {
      return { state: "VERIFIED", expiresAt: null, privacyNoticeVersion: record.privacyNoticeVersion };
    }
    if (record.verificationExpiresAt && record.verificationExpiresAt > now) {
      return { state: "PENDING", expiresAt: record.verificationExpiresAt, privacyNoticeVersion: record.privacyNoticeVersion };
    }
    return { state: "NOT_STARTED", expiresAt: null, privacyNoticeVersion: record.privacyNoticeVersion };
  }

  async prepareVerification(input: {
    userId: string;
    emailHash: string;
    encryptedEmail: string;
    verificationCodeHash: string;
    expiresAt: Date;
    privacyNoticeVersion: string;
    acceptedAt: Date;
    resendCooldownMs: number;
  }): Promise<{ status: "READY"; verificationId: string } | { status: "ALREADY_VERIFIED" } | { status: "COOLDOWN"; retryAfterMs: number }> {
    return this.prisma.$transaction(async (transaction) => {
      const [current, addressOwner] = await Promise.all([
        transaction.referralEmailVerification.findUnique({ where: { userId: input.userId } }),
        transaction.referralEmailVerification.findUnique({ where: { emailHash: input.emailHash } }),
      ]);
      if (addressOwner && addressOwner.userId !== input.userId) {
        throw new ReferralEmailRepositoryError("EMAIL_UNAVAILABLE");
      }
      if (current?.verifiedAt) {
        if (current.emailHash === input.emailHash) {
          return { status: "ALREADY_VERIFIED" } as const;
        }
        throw new ReferralEmailRepositoryError("EMAIL_CHANGE_NOT_ALLOWED");
      }
      if (current?.lastSentAt) {
        const retryAfterMs = current.lastSentAt.getTime() + input.resendCooldownMs - input.acceptedAt.getTime();
        if (retryAfterMs > 0) {
          return { status: "COOLDOWN", retryAfterMs } as const;
        }
      }
      const payload = {
        emailHash: input.emailHash,
        encryptedEmail: input.encryptedEmail,
        verificationCodeHash: input.verificationCodeHash,
        verificationExpiresAt: input.expiresAt,
        failedAttempts: 0,
        lastSentAt: input.acceptedAt,
        privacyNoticeVersion: input.privacyNoticeVersion,
        privacyAcceptedAt: input.acceptedAt,
      };
      const row = current
        ? await transaction.referralEmailVerification.update({ where: { userId: input.userId }, data: payload })
        : await transaction.referralEmailVerification.create({ data: { userId: input.userId, ...payload } });
      await transaction.auditEvent.create({
        data: {
          userId: input.userId,
          action: "referral_email_verification_requested",
          entityType: "referral_email_verification",
          entityId: row.id,
          metadata: { privacyNoticeVersion: input.privacyNoticeVersion },
        },
      });
      return { status: "READY", verificationId: row.id } as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async cancelPreparedVerification(input: { userId: string; verificationId: string }): Promise<void> {
    await this.prisma.referralEmailVerification.deleteMany({
      where: { id: input.verificationId, userId: input.userId, verifiedAt: null },
    });
  }

  async findVerification(userId: string, now: Date): Promise<EmailVerificationRow & { state: ReferralEmailVerificationState; expiresAt: Date | null; privacyNoticeVersion: string | null } | null> {
    const record = await this.prisma.referralEmailVerification.findUnique({ where: { userId } });
    return record ? toRecord(record, now) : null;
  }

  async markVerified(input: { userId: string; verificationId: string; verificationCodeHash: string; now: Date }): Promise<boolean> {
    const updated = await this.prisma.referralEmailVerification.updateMany({
      where: {
        id: input.verificationId,
        userId: input.userId,
        verifiedAt: null,
        verificationCodeHash: input.verificationCodeHash,
        verificationExpiresAt: { gt: input.now },
      },
      data: {
        verifiedAt: input.now,
        verificationCodeHash: null,
        verificationExpiresAt: null,
        failedAttempts: 0,
      },
    });
    if (updated.count === 1) {
      await this.prisma.auditEvent.create({
        data: {
          userId: input.userId,
          action: "referral_email_verified",
          entityType: "referral_email_verification",
          entityId: input.verificationId,
        },
      });
    }
    return updated.count === 1;
  }

  async recordFailedAttempt(input: { userId: string; verificationId: string; maxAttempts: number; now: Date }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.referralEmailVerification.findFirst({
        where: { id: input.verificationId, userId: input.userId, verifiedAt: null },
      });
      if (!current) {
        return;
      }
      const attempts = current.failedAttempts + 1;
      await transaction.referralEmailVerification.update({
        where: { id: current.id },
        data: attempts >= input.maxAttempts
          ? { failedAttempts: attempts, verificationCodeHash: null, verificationExpiresAt: input.now }
          : { failedAttempts: attempts },
      });
    });
  }

  async isVerified(userId: string, _now: Date): Promise<boolean> {
    return Boolean(await this.prisma.referralEmailVerification.findFirst({
      where: { userId, verifiedAt: { not: null } },
      select: { id: true },
    }));
  }
}

function toRecord(record: EmailVerificationRow, now: Date): EmailVerificationRow & { state: ReferralEmailVerificationState; expiresAt: Date | null; privacyNoticeVersion: string | null } {
  return {
    ...record,
    state: record.verifiedAt ? "VERIFIED" : record.verificationExpiresAt && record.verificationExpiresAt > now ? "PENDING" : "NOT_STARTED",
    expiresAt: record.verificationExpiresAt,
    privacyNoticeVersion: record.privacyNoticeVersion,
  };
}
