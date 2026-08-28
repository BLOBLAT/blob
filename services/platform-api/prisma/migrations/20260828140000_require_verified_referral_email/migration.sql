-- A referral email is verified through a one-time code. The application keeps
-- only keyed HMAC values, never an address or a verification code in plaintext.

CREATE TABLE "ReferralEmailVerification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "verificationCodeHash" TEXT,
  "verificationExpiresAt" TIMESTAMP(3),
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastSentAt" TIMESTAMP(3),
  "privacyNoticeVersion" TEXT NOT NULL,
  "privacyAcceptedAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReferralEmailVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralEmailVerification_userId_key" ON "ReferralEmailVerification"("userId");
CREATE UNIQUE INDEX "ReferralEmailVerification_emailHash_key" ON "ReferralEmailVerification"("emailHash");
CREATE INDEX "ReferralEmailVerification_verifiedAt_idx" ON "ReferralEmailVerification"("verifiedAt");
CREATE INDEX "ReferralEmailVerification_verificationExpiresAt_idx" ON "ReferralEmailVerification"("verificationExpiresAt");

ALTER TABLE "ReferralEmailVerification" ADD CONSTRAINT "ReferralEmailVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
