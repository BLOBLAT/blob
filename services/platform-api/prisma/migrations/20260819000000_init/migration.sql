-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaidMatchStatus" AS ENUM ('DRAFT', 'OPEN', 'FUNDING', 'READY', 'STARTING', 'LIVE', 'FINALIZING', 'SETTLED', 'CANCELLED', 'REFUNDING', 'REFUNDED');
CREATE TYPE "PaidRuleset" AS ENUM ('SKILL', 'REBUY');
CREATE TYPE "EntryStatus" AS ENUM ('RESERVED', 'PENDING', 'VERIFIED', 'REJECTED', 'REFUNDING', 'REFUNDED');
CREATE TYPE "ReviveStatus" AS ENUM ('OFFERED', 'PAYMENT_PENDING', 'VERIFIED', 'PERMIT_ISSUED', 'EXPIRED', 'REJECTED', 'CONSUMED');
CREATE TYPE "ChainTransactionKind" AS ENUM ('ENTRY', 'REVIVE', 'SETTLEMENT', 'REFUND');

-- CreateTable
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "displayNameKey" TEXT NOT NULL,
  "renamedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Wallet" (
  "id" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthChallenge" (
  "id" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "messageHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Match" (
  "id" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "status" "PaidMatchStatus" NOT NULL DEFAULT 'DRAFT',
  "ruleset" "PaidRuleset" NOT NULL,
  "rulesVersion" TEXT NOT NULL,
  "rulesHash" TEXT NOT NULL,
  "settlementAsset" TEXT NOT NULL,
  "usdcMint" TEXT NOT NULL,
  "entryAmountBaseUnits" BIGINT NOT NULL,
  "reviveAmountBaseUnits" BIGINT,
  "maxRevivesPerPlayer" INTEGER NOT NULL DEFAULT 0,
  "reviveWindowMs" INTEGER,
  "reviveCutoffMs" INTEGER,
  "platformFeeBps" INTEGER NOT NULL,
  "payoutBps" INTEGER[],
  "minimumPlayers" INTEGER NOT NULL,
  "maximumPlayers" INTEGER NOT NULL,
  "fundingDeadline" TIMESTAMP(3) NOT NULL,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "escrowAddress" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchEntry" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "status" "EntryStatus" NOT NULL DEFAULT 'RESERVED',
  "amountBaseUnits" BIGINT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "admissionTokenHash" TEXT,
  "fundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MatchEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeathEvent" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "reviveExpiresAt" TIMESTAMP(3) NOT NULL,
  "reviveCutoffAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeathEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviveRequest" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "deathId" TEXT NOT NULL,
  "status" "ReviveStatus" NOT NULL DEFAULT 'OFFERED',
  "amountBaseUnits" BIGINT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "permitHash" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "transactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviveRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChainTransaction" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "kind" "ChainTransactionKind" NOT NULL,
  "signature" TEXT NOT NULL,
  "amountBaseUnits" BIGINT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "verificationError" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChainTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SettlementAttempt" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "resultHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "transactionId" TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  "error" TEXT,
  CONSTRAINT "SettlementAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payout" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "place" INTEGER NOT NULL,
  "amountBaseUnits" BIGINT NOT NULL,
  "transactionId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "requestId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_displayNameKey_idx" ON "User"("displayNameKey");
CREATE UNIQUE INDEX "Wallet_address_key" ON "Wallet"("address");
CREATE UNIQUE INDEX "AuthChallenge_nonce_key" ON "AuthChallenge"("nonce");
CREATE INDEX "AuthChallenge_walletAddress_expiresAt_idx" ON "AuthChallenge"("walletAddress", "expiresAt");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");
CREATE INDEX "Session_walletAddress_expiresAt_idx" ON "Session"("walletAddress", "expiresAt");
CREATE UNIQUE INDEX "Match_roundId_key" ON "Match"("roundId");
CREATE UNIQUE INDEX "Match_escrowAddress_key" ON "Match"("escrowAddress");
CREATE INDEX "Match_status_fundingDeadline_idx" ON "Match"("status", "fundingDeadline");
CREATE UNIQUE INDEX "MatchEntry_idempotencyKey_key" ON "MatchEntry"("idempotencyKey");
CREATE UNIQUE INDEX "MatchEntry_admissionTokenHash_key" ON "MatchEntry"("admissionTokenHash");
CREATE INDEX "MatchEntry_matchId_status_idx" ON "MatchEntry"("matchId", "status");
CREATE UNIQUE INDEX "MatchEntry_matchId_userId_key" ON "MatchEntry"("matchId", "userId");
CREATE INDEX "DeathEvent_matchId_entryId_occurredAt_idx" ON "DeathEvent"("matchId", "entryId", "occurredAt");
CREATE UNIQUE INDEX "ReviveRequest_permitHash_key" ON "ReviveRequest"("permitHash");
CREATE UNIQUE INDEX "ReviveRequest_idempotencyKey_key" ON "ReviveRequest"("idempotencyKey");
CREATE UNIQUE INDEX "ReviveRequest_transactionId_key" ON "ReviveRequest"("transactionId");
CREATE INDEX "ReviveRequest_matchId_status_expiresAt_idx" ON "ReviveRequest"("matchId", "status", "expiresAt");
CREATE UNIQUE INDEX "ReviveRequest_entryId_deathId_key" ON "ReviveRequest"("entryId", "deathId");
CREATE UNIQUE INDEX "ChainTransaction_signature_key" ON "ChainTransaction"("signature");
CREATE UNIQUE INDEX "ChainTransaction_idempotencyKey_key" ON "ChainTransaction"("idempotencyKey");
CREATE INDEX "ChainTransaction_matchId_kind_finalizedAt_idx" ON "ChainTransaction"("matchId", "kind", "finalizedAt");
CREATE UNIQUE INDEX "SettlementAttempt_idempotencyKey_key" ON "SettlementAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "SettlementAttempt_transactionId_key" ON "SettlementAttempt"("transactionId");
CREATE INDEX "SettlementAttempt_matchId_settledAt_idx" ON "SettlementAttempt"("matchId", "settledAt");
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");
CREATE INDEX "Payout_entryId_idx" ON "Payout"("entryId");
CREATE UNIQUE INDEX "Payout_matchId_place_key" ON "Payout"("matchId", "place");
CREATE INDEX "AuditEvent_entityType_entityId_createdAt_idx" ON "AuditEvent"("entityType", "entityId", "createdAt");
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchEntry" ADD CONSTRAINT "MatchEntry_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchEntry" ADD CONSTRAINT "MatchEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MatchEntry" ADD CONSTRAINT "MatchEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeathEvent" ADD CONSTRAINT "DeathEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeathEvent" ADD CONSTRAINT "DeathEvent_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "MatchEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeathEvent" ADD CONSTRAINT "DeathEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviveRequest" ADD CONSTRAINT "ReviveRequest_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviveRequest" ADD CONSTRAINT "ReviveRequest_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "MatchEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviveRequest" ADD CONSTRAINT "ReviveRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviveRequest" ADD CONSTRAINT "ReviveRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviveRequest" ADD CONSTRAINT "ReviveRequest_deathId_fkey" FOREIGN KEY ("deathId") REFERENCES "DeathEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviveRequest" ADD CONSTRAINT "ReviveRequest_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ChainTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChainTransaction" ADD CONSTRAINT "ChainTransaction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SettlementAttempt" ADD CONSTRAINT "SettlementAttempt_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SettlementAttempt" ADD CONSTRAINT "SettlementAttempt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ChainTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "MatchEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ChainTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
