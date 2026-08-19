-- Persist every value included in the immutable paid-match rules hash.
-- Existing databases are upgraded to the canonical disabled-Skill defaults.
ALTER TABLE "Match"
  ADD COLUMN "reviveSpawnProtectionMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "roundDurationMs" INTEGER NOT NULL DEFAULT 600000;

UPDATE "Match"
SET
  "reviveAmountBaseUnits" = COALESCE("reviveAmountBaseUnits", 0),
  "reviveWindowMs" = COALESCE("reviveWindowMs", 0),
  "reviveCutoffMs" = COALESCE("reviveCutoffMs", 0);

ALTER TABLE "Match"
  ALTER COLUMN "reviveAmountBaseUnits" SET DEFAULT 0,
  ALTER COLUMN "reviveAmountBaseUnits" SET NOT NULL,
  ALTER COLUMN "reviveWindowMs" SET DEFAULT 0,
  ALTER COLUMN "reviveWindowMs" SET NOT NULL,
  ALTER COLUMN "reviveCutoffMs" SET DEFAULT 0,
  ALTER COLUMN "reviveCutoffMs" SET NOT NULL;
