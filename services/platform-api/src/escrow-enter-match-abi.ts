import { createHash } from "node:crypto";

const ENTER_MATCH_DISCRIMINATOR = createHash("sha256")
  .update("global:enter_match", "utf8")
  .digest()
  .subarray(0, 8);

/**
 * Anchor's `enter_match` instruction currently has no arguments, so its
 * entire canonical data payload is this discriminator. Returning only bytes
 * keeps this helper free of transactions, wallet prompts, RPC calls, and
 * token-transfer side effects.
 */
export function serializeEnterMatchInstructionData(): Buffer {
  return Buffer.from(ENTER_MATCH_DISCRIMINATOR);
}
