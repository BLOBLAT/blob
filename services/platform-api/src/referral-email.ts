import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const REFERRAL_PRIVACY_NOTICE_VERSION = "2026-08-28";

export type ReferralEmailVerificationState = "NOT_STARTED" | "PENDING" | "VERIFIED";

export interface ReferralEmailVerificationStatus {
  state: ReferralEmailVerificationState;
  expiresAt: Date | null;
  privacyNoticeVersion: string | null;
}

interface ReferralEmailVerificationRecord extends ReferralEmailVerificationStatus {
  id: string;
  userId: string;
  emailHash: string;
  verificationCodeHash: string | null;
  failedAttempts: number;
}

export interface ReferralEmailRepository {
  getStatus(userId: string, now: Date): Promise<ReferralEmailVerificationStatus>;
  prepareVerification(input: {
    userId: string;
    emailHash: string;
    verificationCodeHash: string;
    expiresAt: Date;
    privacyNoticeVersion: string;
    acceptedAt: Date;
    resendCooldownMs: number;
  }): Promise<{ status: "READY"; verificationId: string } | { status: "ALREADY_VERIFIED" } | { status: "COOLDOWN"; retryAfterMs: number }>;
  cancelPreparedVerification(input: { userId: string; verificationId: string }): Promise<void>;
  findVerification(userId: string, now: Date): Promise<ReferralEmailVerificationRecord | null>;
  markVerified(input: { userId: string; verificationId: string; verificationCodeHash: string; now: Date }): Promise<boolean>;
  recordFailedAttempt(input: { userId: string; verificationId: string; maxAttempts: number; now: Date }): Promise<void>;
  isVerified(userId: string, now: Date): Promise<boolean>;
}

export interface ReferralEmailSender {
  sendVerification(input: { email: string; code: string; expiresAt: Date; idempotencyKey: string }): Promise<void>;
}

export interface ReferralEmailServiceConfig {
  hashSecret: Uint8Array;
  verificationTtlMs: number;
  resendCooldownMs: number;
  maxFailedAttempts: number;
}

export type ReferralEmailStartResult = "PENDING" | "ALREADY_VERIFIED" | "COOLDOWN";
export type ReferralEmailVerifyResult = "VERIFIED" | "INVALID_CODE" | "EXPIRED" | "NOT_STARTED" | "ALREADY_VERIFIED";

export class ReferralEmailError extends Error {
  constructor(
    readonly code: "EMAIL_INVALID" | "EMAIL_UNAVAILABLE" | "EMAIL_CHANGE_NOT_ALLOWED" | "EMAIL_DELIVERY_UNAVAILABLE" | "PRIVACY_CONSENT_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Referral membership uses a short verification code, but the application
 * deliberately persists only an HMAC of the normalized email. The address is
 * supplied to the delivery provider for the one verification message and is
 * never placed in PostgreSQL, arena state, logs, or browser storage.
 */
export class ReferralEmailService {
  constructor(
    private readonly repository: ReferralEmailRepository,
    private readonly sender: ReferralEmailSender,
    private readonly config: ReferralEmailServiceConfig,
  ) {}

  async getStatus(userId: string, now = new Date()): Promise<ReferralEmailVerificationStatus> {
    return this.repository.getStatus(userId, now);
  }

  async start(input: { userId: string; email: string; privacyNoticeVersion: string; acceptedPrivacyNotice: boolean; now?: Date }): Promise<{ status: ReferralEmailStartResult; retryAfterMs?: number }> {
    if (!input.acceptedPrivacyNotice || input.privacyNoticeVersion !== REFERRAL_PRIVACY_NOTICE_VERSION) {
      throw new ReferralEmailError("PRIVACY_CONSENT_REQUIRED", "Accept the current Privacy Notice before verifying an email.");
    }
    const email = normalizeEmail(input.email);
    const now = input.now ?? new Date();
    const emailHash = this.hash("email:v1:" + email);
    const code = String(randomInt(100_000, 1_000_000));
    const verificationCodeHash = this.hash("code:v1:" + emailHash + ":" + code);
    const expiresAt = new Date(now.getTime() + this.config.verificationTtlMs);
    let prepared: { status: "READY"; verificationId: string } | { status: "ALREADY_VERIFIED" } | { status: "COOLDOWN"; retryAfterMs: number };
    try {
      prepared = await this.repository.prepareVerification({
        userId: input.userId,
        emailHash,
        verificationCodeHash,
        expiresAt,
        privacyNoticeVersion: REFERRAL_PRIVACY_NOTICE_VERSION,
        acceptedAt: now,
        resendCooldownMs: this.config.resendCooldownMs,
      });
    } catch (error) {
      throw translateRepositoryError(error);
    }
    if (prepared.status === "ALREADY_VERIFIED") {
      return { status: "ALREADY_VERIFIED" };
    }
    if (prepared.status === "COOLDOWN") {
      return { status: "COOLDOWN", retryAfterMs: prepared.retryAfterMs };
    }
    try {
      await this.sender.sendVerification({
        email,
        code,
        expiresAt,
        idempotencyKey: "blob-referral-email:" + prepared.verificationId,
      });
    } catch {
      await this.repository.cancelPreparedVerification({ userId: input.userId, verificationId: prepared.verificationId });
      throw new ReferralEmailError("EMAIL_DELIVERY_UNAVAILABLE", "The verification email could not be sent. Please try again later.");
    }
    return { status: "PENDING" };
  }

  async verify(input: { userId: string; code: string; now?: Date }): Promise<ReferralEmailVerifyResult> {
    if (!/^\d{6}$/.test(input.code)) {
      return "INVALID_CODE";
    }
    const now = input.now ?? new Date();
    const record = await this.repository.findVerification(input.userId, now);
    if (!record) {
      return "NOT_STARTED";
    }
    if (record.state === "VERIFIED") {
      return "ALREADY_VERIFIED";
    }
    if (!record.expiresAt || record.expiresAt <= now || !record.verificationCodeHash) {
      return "EXPIRED";
    }
    const candidate = this.hash("code:v1:" + record.emailHash + ":" + input.code);
    if (!safeHashEqual(candidate, record.verificationCodeHash)) {
      await this.repository.recordFailedAttempt({
        userId: input.userId,
        verificationId: record.id,
        maxAttempts: this.config.maxFailedAttempts,
        now,
      });
      return "INVALID_CODE";
    }
    const verified = await this.repository.markVerified({
      userId: input.userId,
      verificationId: record.id,
      verificationCodeHash: candidate,
      now,
    });
    return verified ? "VERIFIED" : "EXPIRED";
  }

  private hash(value: string): string {
    return createHmac("sha256", this.config.hashSecret).update(value).digest("base64url");
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /[\u0000-\u001f\u007f\s]/.test(email)) {
    throw new ReferralEmailError("EMAIL_INVALID", "Enter a valid email address.");
  }
  // This is deliberately conservative rather than attempting to fully parse
  // every RFC form. The delivery provider remains the final mailbox check.
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new ReferralEmailError("EMAIL_INVALID", "Enter a valid email address.");
  }
  return email;
}

export function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function translateRepositoryError(error: unknown): ReferralEmailError {
  if (error instanceof ReferralEmailRepositoryError) {
    return new ReferralEmailError(
      error.code,
      error.code === "EMAIL_UNAVAILABLE"
        ? "This email cannot be used for another BLOB referral profile."
        : "A verified referral email cannot be changed from this profile.",
    );
  }
  throw error;
}

export class ReferralEmailRepositoryError extends Error {
  constructor(readonly code: "EMAIL_UNAVAILABLE" | "EMAIL_CHANGE_NOT_ALLOWED") {
    super(code);
  }
}
