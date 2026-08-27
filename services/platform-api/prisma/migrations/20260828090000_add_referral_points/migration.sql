-- BLOB referral program: opaque code attribution and append-only points.
-- Neither a wallet address nor a browser-controlled balance is stored here.

CREATE TYPE "ReferralPointReason" AS ENUM ('REFERRER_QUALIFIED_PLAYER', 'REFEREE_QUALIFIED_PLAYER', 'ADMIN_ADJUSTMENT');
CREATE TYPE "ReferralAttributionStatus" AS ENUM ('PENDING', 'QUALIFIED', 'BLOCKED');
CREATE TYPE "ReferralQualificationKind" AS ENUM ('FREE_ROUND_COMPLETED');

CREATE TABLE "ReferralCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralAttribution" (
  "id" TEXT NOT NULL,
  "referralCodeId" TEXT NOT NULL,
  "referrerUserId" TEXT NOT NULL,
  "refereeUserId" TEXT NOT NULL,
  "status" "ReferralAttributionStatus" NOT NULL DEFAULT 'PENDING',
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "qualifiedAt" TIMESTAMP(3),
  "blockedAt" TIMESTAMP(3),
  CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralQualification" (
  "id" TEXT NOT NULL,
  "attributionId" TEXT NOT NULL,
  "refereeUserId" TEXT NOT NULL,
  "kind" "ReferralQualificationKind" NOT NULL,
  "matchId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "qualifiedAt" TIMESTAMP(3) NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralQualification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralPointsLedger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "delta" BIGINT NOT NULL,
  "reason" "ReferralPointReason" NOT NULL,
  "referralAttributionId" TEXT,
  "qualificationId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralPointsLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE UNIQUE INDEX "ReferralCode_userId_key" ON "ReferralCode"("userId");
CREATE INDEX "ReferralCode_revokedAt_idx" ON "ReferralCode"("revokedAt");
CREATE UNIQUE INDEX "ReferralAttribution_refereeUserId_key" ON "ReferralAttribution"("refereeUserId");
CREATE INDEX "ReferralAttribution_referrerUserId_status_idx" ON "ReferralAttribution"("referrerUserId", "status");
CREATE INDEX "ReferralAttribution_referralCodeId_status_idx" ON "ReferralAttribution"("referralCodeId", "status");
CREATE UNIQUE INDEX "ReferralQualification_sourceEventId_key" ON "ReferralQualification"("sourceEventId");
CREATE UNIQUE INDEX "ReferralQualification_refereeUserId_kind_key" ON "ReferralQualification"("refereeUserId", "kind");
CREATE UNIQUE INDEX "ReferralQualification_refereeUserId_matchId_roundId_kind_key" ON "ReferralQualification"("refereeUserId", "matchId", "roundId", "kind");
CREATE INDEX "ReferralQualification_attributionId_qualifiedAt_idx" ON "ReferralQualification"("attributionId", "qualifiedAt");
CREATE UNIQUE INDEX "ReferralPointsLedger_idempotencyKey_key" ON "ReferralPointsLedger"("idempotencyKey");
CREATE INDEX "ReferralPointsLedger_userId_createdAt_idx" ON "ReferralPointsLedger"("userId", "createdAt");
CREATE INDEX "ReferralPointsLedger_referralAttributionId_idx" ON "ReferralPointsLedger"("referralAttributionId");
CREATE INDEX "ReferralPointsLedger_qualificationId_idx" ON "ReferralPointsLedger"("qualificationId");

ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_referralCodeId_fkey"
  FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_referrerUserId_fkey"
  FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_refereeUserId_fkey"
  FOREIGN KEY ("refereeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralQualification" ADD CONSTRAINT "ReferralQualification_attributionId_fkey"
  FOREIGN KEY ("attributionId") REFERENCES "ReferralAttribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralQualification" ADD CONSTRAINT "ReferralQualification_refereeUserId_fkey"
  FOREIGN KEY ("refereeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralPointsLedger" ADD CONSTRAINT "ReferralPointsLedger_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralPointsLedger" ADD CONSTRAINT "ReferralPointsLedger_referralAttributionId_fkey"
  FOREIGN KEY ("referralAttributionId") REFERENCES "ReferralAttribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralPointsLedger" ADD CONSTRAINT "ReferralPointsLedger_qualificationId_fkey"
  FOREIGN KEY ("qualificationId") REFERENCES "ReferralQualification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
