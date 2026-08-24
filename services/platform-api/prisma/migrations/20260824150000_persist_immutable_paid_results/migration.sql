-- Paid Mode is still disabled, so no settlement attempt or paid entry may
-- exist before this foundation migration. Do not fabricate missing player or
-- result data: fail closed and investigate any unexpected durable records.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "MatchEntry")
    OR EXISTS (SELECT 1 FROM "SettlementAttempt")
    OR EXISTS (SELECT 1 FROM "Payout") THEN
    RAISE EXCEPTION 'Cannot add immutable paid-result bindings while paid records already exist.';
  END IF;
END $$;

ALTER TABLE "MatchEntry"
  ADD COLUMN "playerId" TEXT NOT NULL;

CREATE UNIQUE INDEX "MatchEntry_matchId_playerId_key"
  ON "MatchEntry"("matchId", "playerId");

CREATE TABLE "MatchResult" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "rulesHash" TEXT NOT NULL,
  "resultHash" TEXT NOT NULL,
  "resultPayload" JSONB NOT NULL,
  "finalizedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchResult_matchId_key" ON "MatchResult"("matchId");
CREATE UNIQUE INDEX "MatchResult_roundId_key" ON "MatchResult"("roundId");
CREATE UNIQUE INDEX "MatchResult_resultHash_key" ON "MatchResult"("resultHash");

ALTER TABLE "SettlementAttempt"
  ADD COLUMN "resultId" TEXT NOT NULL,
  ADD COLUMN "settlementId" TEXT NOT NULL;

ALTER TABLE "Payout"
  ADD COLUMN "resultId" TEXT NOT NULL;

CREATE UNIQUE INDEX "SettlementAttempt_resultId_key" ON "SettlementAttempt"("resultId");
CREATE UNIQUE INDEX "SettlementAttempt_settlementId_key" ON "SettlementAttempt"("settlementId");

ALTER TABLE "MatchResult"
  ADD CONSTRAINT "MatchResult_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SettlementAttempt"
  ADD CONSTRAINT "SettlementAttempt_resultId_fkey"
  FOREIGN KEY ("resultId") REFERENCES "MatchResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payout"
  ADD CONSTRAINT "Payout_resultId_fkey"
  FOREIGN KEY ("resultId") REFERENCES "MatchResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
