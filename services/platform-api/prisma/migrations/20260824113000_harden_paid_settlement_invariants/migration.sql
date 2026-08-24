-- Paid Mode remains disabled, but its durable records must not admit an
-- ambiguous payout policy or more than one settlement/payout path. Do not
-- backfill a missing payout split: it is part of the immutable rules hash and
-- an affected pre-production database must be investigated instead.
ALTER TABLE "Match"
  ALTER COLUMN "payoutBps" SET NOT NULL;

-- A retry must update the same authoritative settlement attempt. A match
-- therefore cannot have competing result hashes or independent settlement
-- requests.
CREATE UNIQUE INDEX "SettlementAttempt_matchId_key"
  ON "SettlementAttempt"("matchId");

-- A single verified entry can receive one final prize place only.
CREATE UNIQUE INDEX "Payout_matchId_entryId_key"
  ON "Payout"("matchId", "entryId");
