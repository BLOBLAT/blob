-- Immutable future Paid Arena rules: a 10% platform fee, a 10% participation
-- rebate for every verified rank outside the podium, and explicit payout kind.
CREATE TYPE "PayoutKind" AS ENUM ('PRIZE', 'PARTICIPATION_REBATE');

ALTER TABLE "Match"
  ADD COLUMN "participationRebateBps" INTEGER NOT NULL DEFAULT 1000;

ALTER TABLE "Payout"
  ADD COLUMN "kind" "PayoutKind" NOT NULL DEFAULT 'PRIZE',
  ALTER COLUMN "place" DROP NOT NULL;
