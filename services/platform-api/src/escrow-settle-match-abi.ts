import { createHash } from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SETTLE_MATCH_DISCRIMINATOR = createHash("sha256")
  .update("global:settle_match", "utf8")
  .digest()
  .subarray(0, 8);

/**
 * Serializes Anchor's one `final_result_hash: [u8; 32]` settlement argument.
 * It has no transaction, RPC, signer, wallet, or transfer side effect.
 */
export function serializeSettleMatchInstructionData(finalResultHash: string): Buffer {
  if (!HASH_PATTERN.test(finalResultHash) || /^0{64}$/i.test(finalResultHash)) {
    throw new EscrowSettleMatchAbiError("RESULT_HASH_INVALID", "The final result hash must be a non-zero 32-byte SHA-256 hex value.");
  }
  return Buffer.concat([
    SETTLE_MATCH_DISCRIMINATOR,
    Buffer.from(finalResultHash, "hex"),
  ]);
}

export class EscrowSettleMatchAbiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
