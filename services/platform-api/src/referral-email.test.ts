import { describe, expect, it } from "vitest";
import {
  ReferralEmailError,
  ReferralEmailRepositoryError,
  ReferralEmailService,
  type ReferralEmailRepository,
  type ReferralEmailSender,
  type ReferralEmailVerificationStatus,
} from "./referral-email.js";

describe("referral email verification", () => {
  it("requires a delivered one-time code before referral membership is verified", async () => {
    const repository = new MemoryRepository();
    const deliveries: Array<{ email: string; code: string }> = [];
    const service = new ReferralEmailService(repository, {
      sendVerification: async ({ email, code }) => { deliveries.push({ email, code }); },
    }, config());

    await expect(service.start({
      userId: "user-a",
      email: " Player@Example.com ",
      privacyNoticeVersion: "2026-08-28",
      acceptedPrivacyNotice: true,
      now: new Date("2026-08-28T10:00:00.000Z"),
    })).resolves.toEqual({ status: "PENDING" });
    expect(deliveries).toEqual([{ email: "player@example.com", code: expect.stringMatching(/^\d{6}$/) }]);
    expect(repository.rows[0]?.emailHash).not.toContain("player@example.com");
    expect(repository.rows[0]?.encryptedEmail).not.toContain("player@example.com");
    await expect(service.verify({ userId: "user-a", code: "000000", now: new Date("2026-08-28T10:01:00.000Z") }))
      .resolves.toBe("INVALID_CODE");
    await expect(service.verify({ userId: "user-a", code: deliveries[0]!.code, now: new Date("2026-08-28T10:01:00.000Z") }))
      .resolves.toBe("VERIFIED");
    await expect(service.getStatus("user-a", new Date("2026-08-28T10:02:00.000Z")))
      .resolves.toMatchObject({ state: "VERIFIED" });
  });

  it("does not claim a code was sent if the delivery provider fails", async () => {
    const repository = new MemoryRepository();
    const service = new ReferralEmailService(repository, {
      sendVerification: async () => { throw new Error("provider outage"); },
    }, config());
    await expect(service.start({
      userId: "user-a",
      email: "player@example.com",
      privacyNoticeVersion: "2026-08-28",
      acceptedPrivacyNotice: true,
    })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_UNAVAILABLE" });
    expect(repository.rows).toHaveLength(0);
  });

  it("does not allow an email fingerprint to verify a second referral profile", async () => {
    const repository = new MemoryRepository();
    const sender: ReferralEmailSender = { sendVerification: async () => undefined };
    const service = new ReferralEmailService(repository, sender, config());
    await service.start({ userId: "user-a", email: "player@example.com", privacyNoticeVersion: "2026-08-28", acceptedPrivacyNotice: true });
    await expect(service.start({ userId: "user-b", email: "player@example.com", privacyNoticeVersion: "2026-08-28", acceptedPrivacyNotice: true }))
      .rejects.toMatchObject({ code: "EMAIL_UNAVAILABLE" } satisfies Partial<ReferralEmailError>);
  });
});

interface Row {
  id: string;
  userId: string;
  emailHash: string;
  encryptedEmail: string | null;
  verificationCodeHash: string | null;
  verificationExpiresAt: Date | null;
  failedAttempts: number;
  privacyNoticeVersion: string;
  verifiedAt: Date | null;
  lastSentAt: Date | null;
}

class MemoryRepository implements ReferralEmailRepository {
  readonly rows: Row[] = [];

  async getStatus(userId: string, now: Date): Promise<ReferralEmailVerificationStatus> {
    const row = this.rows.find((candidate) => candidate.userId === userId);
    return toStatus(row, now);
  }

  async prepareVerification(input: {
    userId: string; emailHash: string; encryptedEmail: string; verificationCodeHash: string; expiresAt: Date; privacyNoticeVersion: string; acceptedAt: Date; resendCooldownMs: number;
  }): Promise<{ status: "READY"; verificationId: string } | { status: "ALREADY_VERIFIED" } | { status: "COOLDOWN"; retryAfterMs: number }> {
    const owner = this.rows.find((row) => row.emailHash === input.emailHash);
    if (owner && owner.userId !== input.userId) throw new ReferralEmailRepositoryError("EMAIL_UNAVAILABLE");
    const current = this.rows.find((row) => row.userId === input.userId);
    if (current?.verifiedAt) {
      if (current.emailHash === input.emailHash) return { status: "ALREADY_VERIFIED" };
      throw new ReferralEmailRepositoryError("EMAIL_CHANGE_NOT_ALLOWED");
    }
    if (current?.lastSentAt) {
      const retryAfterMs = current.lastSentAt.getTime() + input.resendCooldownMs - input.acceptedAt.getTime();
      if (retryAfterMs > 0) return { status: "COOLDOWN", retryAfterMs };
    }
    const row = current ?? {
      id: "email-" + (this.rows.length + 1), userId: input.userId, emailHash: input.emailHash,
      encryptedEmail: null,
      verificationCodeHash: null, verificationExpiresAt: null, failedAttempts: 0,
      privacyNoticeVersion: input.privacyNoticeVersion, verifiedAt: null, lastSentAt: null,
    };
    Object.assign(row, {
      emailHash: input.emailHash, verificationCodeHash: input.verificationCodeHash,
      encryptedEmail: input.encryptedEmail,
      verificationExpiresAt: input.expiresAt, failedAttempts: 0, lastSentAt: input.acceptedAt,
      privacyNoticeVersion: input.privacyNoticeVersion,
    });
    if (!current) this.rows.push(row);
    return { status: "READY", verificationId: row.id };
  }

  async cancelPreparedVerification(input: { userId: string; verificationId: string }): Promise<void> {
    const index = this.rows.findIndex((row) => row.userId === input.userId && row.id === input.verificationId && !row.verifiedAt);
    if (index >= 0) this.rows.splice(index, 1);
  }

  async findVerification(userId: string, now: Date) {
    const row = this.rows.find((candidate) => candidate.userId === userId);
    if (!row) return null;
    return { ...row, ...toStatus(row, now) };
  }

  async markVerified(input: { userId: string; verificationId: string; verificationCodeHash: string; now: Date }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.userId === input.userId && candidate.id === input.verificationId);
    if (!row || row.verifiedAt || row.verificationCodeHash !== input.verificationCodeHash || !row.verificationExpiresAt || row.verificationExpiresAt <= input.now) return false;
    row.verifiedAt = input.now;
    row.verificationCodeHash = null;
    row.verificationExpiresAt = null;
    return true;
  }

  async recordFailedAttempt(input: { userId: string; verificationId: string; maxAttempts: number; now: Date }): Promise<void> {
    const row = this.rows.find((candidate) => candidate.userId === input.userId && candidate.id === input.verificationId);
    if (!row) return;
    row.failedAttempts += 1;
    if (row.failedAttempts >= input.maxAttempts) {
      row.verificationCodeHash = null;
      row.verificationExpiresAt = input.now;
    }
  }

  async isVerified(userId: string, _now: Date): Promise<boolean> {
    return Boolean(this.rows.find((row) => row.userId === userId)?.verifiedAt);
  }
}

function toStatus(row: Row | undefined, now: Date): ReferralEmailVerificationStatus {
  if (!row) return { state: "NOT_STARTED", expiresAt: null, privacyNoticeVersion: null };
  if (row.verifiedAt) return { state: "VERIFIED", expiresAt: null, privacyNoticeVersion: row.privacyNoticeVersion };
  if (row.verificationExpiresAt && row.verificationExpiresAt > now) return { state: "PENDING", expiresAt: row.verificationExpiresAt, privacyNoticeVersion: row.privacyNoticeVersion };
  return { state: "NOT_STARTED", expiresAt: null, privacyNoticeVersion: row.privacyNoticeVersion };
}

function config() {
  return { hashSecret: new Uint8Array(32).fill(9), encryptionKey: new Uint8Array(32).fill(8), verificationTtlMs: 10 * 60_000, resendCooldownMs: 1, maxFailedAttempts: 5 };
}
