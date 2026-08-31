import { createHash } from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const PURCHASE_REVIVE_DISCRIMINATOR = createHash("sha256")
  .update("global:purchase_revive", "utf8")
  .digest()
  .subarray(0, 8);

/**
 * Serializes Anchor's `purchase_revive(death_id_hash, death_at)` arguments.
 * This emits only bytes; it cannot prompt a wallet, sign, use an RPC, or
 * transfer USDC.
 */
export function serializePurchaseReviveInstructionData(input: {
  deathIdHash: string;
  deathAtUnixSeconds: bigint;
}): Buffer {
  if (!HASH_PATTERN.test(input.deathIdHash) || /^0{64}$/i.test(input.deathIdHash)) {
    throw new EscrowPurchaseReviveAbiError("DEATH_HASH_INVALID", "The death ID hash must be a non-zero 32-byte SHA-256 hex value.");
  }
  if (input.deathAtUnixSeconds < -(1n << 63n) || input.deathAtUnixSeconds > (1n << 63n) - 1n) {
    throw new EscrowPurchaseReviveAbiError("DEATH_TIME_INVALID", "The authoritative death time must fit in an i64 Unix timestamp.");
  }
  const deathAt = Buffer.alloc(8);
  deathAt.writeBigInt64LE(input.deathAtUnixSeconds);
  return Buffer.concat([
    PURCHASE_REVIVE_DISCRIMINATOR,
    Buffer.from(input.deathIdHash, "hex"),
    deathAt,
  ]);
}

export class EscrowPurchaseReviveAbiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
