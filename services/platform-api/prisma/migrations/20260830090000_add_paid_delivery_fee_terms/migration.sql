-- A disclosed optional delivery charge is immutable per match and may only
-- reduce a podium prize. Existing paid play is disabled, but defaults keep
-- historic/seed rows equivalent to the previous zero-fee model.
ALTER TABLE "Match"
  ADD COLUMN "payoutDeliveryFeeBps" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Payout"
  ADD COLUMN "grossAmountBaseUnits" BIGINT,
  ADD COLUMN "deliveryFeeBaseUnits" BIGINT NOT NULL DEFAULT 0;

UPDATE "Payout"
  SET "grossAmountBaseUnits" = "amountBaseUnits"
  WHERE "grossAmountBaseUnits" IS NULL;

ALTER TABLE "Payout"
  ALTER COLUMN "grossAmountBaseUnits" SET NOT NULL;
