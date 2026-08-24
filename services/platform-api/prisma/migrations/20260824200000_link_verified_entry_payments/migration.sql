-- A finalized entry-payment signature may fund one reserved entry only. This
-- relation is nullable for the still-disabled Paid Mode, but once set it is
-- immutable application evidence for admission and later settlement.
ALTER TABLE "MatchEntry"
  ADD COLUMN "transactionId" TEXT;

CREATE UNIQUE INDEX "MatchEntry_transactionId_key"
  ON "MatchEntry"("transactionId");

ALTER TABLE "MatchEntry"
  ADD CONSTRAINT "MatchEntry_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "ChainTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
