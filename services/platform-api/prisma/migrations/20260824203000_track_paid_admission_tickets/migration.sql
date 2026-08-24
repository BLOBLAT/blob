-- A paid admission ticket is a short-lived, single-use bearer credential.
-- Store only its hash, plus server-controlled timestamps, so expired tickets
-- can be replaced while an accepted one remains bound to the entry lifecycle.
ALTER TYPE "EntryStatus" ADD VALUE 'CONSUMED';

ALTER TABLE "MatchEntry"
  ADD COLUMN "admissionIssuedAt" TIMESTAMP(3),
  ADD COLUMN "admissionExpiresAt" TIMESTAMP(3);

CREATE INDEX "MatchEntry_admissionExpiresAt_idx"
  ON "MatchEntry"("admissionExpiresAt");
