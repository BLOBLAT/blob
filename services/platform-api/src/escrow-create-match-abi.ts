import { createHash } from "node:crypto";
import type { EscrowCreateMatchPlan } from "./escrow-instruction-plan.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const CREATE_MATCH_DISCRIMINATOR = createHash("sha256")
  .update("global:create_match", "utf8")
  .digest()
  .subarray(0, 8);

/**
 * Serializes the arguments of Anchor's `create_match` instruction exactly as
 * its Borsh ABI expects. It deliberately does not derive accounts, choose a
 * program, create a transaction, request a wallet signature, or send a
 * network request. Those actions remain disabled until the controlled
 * deployment and audit gates in docs/paid-mode.md are complete.
 */
export function serializeCreateMatchInstructionData(plan: EscrowCreateMatchPlan): Buffer {
  const matchIdHash = hash32(plan.matchIdHash, "match ID hash");
  const roundIdHash = hash32(plan.roundIdHash, "round ID hash");
  assertDistinctMatchAndRoundHashes(matchIdHash, roundIdHash);
  return Buffer.concat([
    CREATE_MATCH_DISCRIMINATOR,
    matchIdHash,
    roundIdHash,
    hash32(plan.onchainRulesHash, "rules hash"),
    u64(plan.entryAmountBaseUnits, "entry amount"),
    u16(plan.payoutDeliveryFeeBps, "payout delivery fee"),
    Buffer.from([plan.reviveEnabled ? 1 : 0]),
    u64(plan.reviveAmountBaseUnits, "revive amount"),
    u16(plan.participationRebateBps, "participation rebate"),
    u16(plan.payoutBps[0], "first-place payout"),
    u16(plan.payoutBps[1], "second-place payout"),
    u16(plan.payoutBps[2], "third-place payout"),
    u16(plan.minimumPlayers, "minimum players"),
    u16(plan.maximumPlayers, "maximum players"),
    i64(plan.fundingDeadlineUnixSeconds, "funding deadline"),
    i64(plan.roundDurationSeconds, "round duration"),
    i64(plan.reviveWindowSeconds, "revive window"),
    i64(plan.reviveCutoffSeconds, "revive cutoff")
  ]);
}

export function createMatchInstructionDiscriminator(): Buffer {
  return Buffer.from(CREATE_MATCH_DISCRIMINATOR);
}

function hash32(value: string, label: string): Buffer {
  if (!HASH_PATTERN.test(value)) {
    throw new EscrowCreateMatchAbiError("INVALID_HASH", "The " + label + " must be 32-byte SHA-256 hex.");
  }
  return Buffer.from(value, "hex");
}

function assertDistinctMatchAndRoundHashes(matchIdHash: Buffer, roundIdHash: Buffer): void {
  if (matchIdHash.equals(roundIdHash)) {
    throw new EscrowCreateMatchAbiError(
      "IDENTIFIERS_NOT_DISTINCT",
      "The match ID hash and round ID hash must be distinct."
    );
  }
}

function u16(value: number, label: string): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new EscrowCreateMatchAbiError("INVALID_INTEGER", "The " + label + " must fit in u16.");
  }
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value);
  return output;
}

function u64(value: bigint, label: string): Buffer {
  if (value < 0n || value > ((1n << 64n) - 1n)) {
    throw new EscrowCreateMatchAbiError("INVALID_INTEGER", "The " + label + " must fit in u64.");
  }
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value);
  return output;
}

function i64(value: bigint, label: string): Buffer {
  if (value < -(1n << 63n) || value > ((1n << 63n) - 1n)) {
    throw new EscrowCreateMatchAbiError("INVALID_INTEGER", "The " + label + " must fit in i64.");
  }
  const output = Buffer.alloc(8);
  output.writeBigInt64LE(value);
  return output;
}

export class EscrowCreateMatchAbiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
