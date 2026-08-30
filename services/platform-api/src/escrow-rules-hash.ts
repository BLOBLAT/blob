import { createHash } from "node:crypto";
import { base58 } from "@scure/base";

/**
 * Server-only replica of `canonical_rules_hash` in the Anchor escrow program.
 * It prepares an immutable commitment for a future controlled orchestration
 * worker; it neither builds nor submits a transaction.
 */
export interface EscrowRulesHashInput {
  matchIdHash: string;
  roundIdHash: string;
  nativeUsdcMint: string;
  platformAuthority: string;
  matchController: string;
  resultAuthority: string;
  treasury: string;
  entryAmountBaseUnits: bigint;
  payoutDeliveryFeeBps: number;
  reviveEnabled: boolean;
  reviveAmountBaseUnits: bigint;
  participationRebateBps: number;
  payoutBps: readonly [number, number, number];
  minimumPlayers: number;
  maximumPlayers: number;
  fundingDeadlineUnixSeconds: bigint;
  roundDurationSeconds: bigint;
  reviveWindowSeconds: bigint;
  reviveCutoffSeconds: bigint;
}

const DOMAIN = Buffer.from("blob-escrow-rules-v1", "utf8");
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const U16_MAX = 0xffff;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/**
 * Returns the lower-case SHA-256 commitment expected by `create_match`.
 * Keep the part order and integer widths synchronized with the Rust program.
 */
export function createEscrowRulesHash(input: EscrowRulesHashInput): string {
  const keys = [
    decodePublicKey(input.nativeUsdcMint, "native USDC mint"),
    decodePublicKey(input.platformAuthority, "platform authority"),
    decodePublicKey(input.matchController, "match controller"),
    decodePublicKey(input.resultAuthority, "result authority"),
    decodePublicKey(input.treasury, "treasury")
  ];
  assertDistinctNonZeroRoles(keys.slice(1));
  const payoutBps = input.payoutBps.map((value, index) => u16(value, "payoutBps[" + index + "]"));

  return createHash("sha256")
    .update(DOMAIN)
    .update(decodeHash(input.matchIdHash, "match ID hash"))
    .update(decodeHash(input.roundIdHash, "round ID hash"))
    .update(keys[0]!)
    .update(keys[1]!)
    .update(keys[2]!)
    .update(keys[3]!)
    .update(keys[4]!)
    .update(u64(input.entryAmountBaseUnits, "entry amount"))
    .update(u16(1_000, "platform fee"))
    .update(u16(input.payoutDeliveryFeeBps, "payout delivery fee"))
    .update(Buffer.from([input.reviveEnabled ? 1 : 0]))
    .update(u64(input.reviveAmountBaseUnits, "revive amount"))
    .update(u16(input.participationRebateBps, "participation rebate"))
    .update(payoutBps[0]!)
    .update(payoutBps[1]!)
    .update(payoutBps[2]!)
    .update(u16(input.minimumPlayers, "minimum players"))
    .update(u16(input.maximumPlayers, "maximum players"))
    .update(i64(input.fundingDeadlineUnixSeconds, "funding deadline"))
    .update(i64(input.roundDurationSeconds, "round duration"))
    .update(i64(input.reviveWindowSeconds, "revive window"))
    .update(i64(input.reviveCutoffSeconds, "revive cutoff"))
    .digest("hex");
}

function decodeHash(value: string, label: string): Buffer {
  if (!HASH_PATTERN.test(value)) {
    throw new EscrowRulesHashError("INVALID_HASH", "The " + label + " must be a SHA-256 hex string.");
  }
  return Buffer.from(value, "hex");
}

function decodePublicKey(value: string, label: string): Buffer {
  try {
    const decoded = base58.decode(value);
    if (decoded.length !== 32) {
      throw new Error("incorrect length");
    }
    return Buffer.from(decoded);
  } catch {
    throw new EscrowRulesHashError("INVALID_PUBLIC_KEY", "The " + label + " is invalid.");
  }
}

function assertDistinctNonZeroRoles(roles: Buffer[]): void {
  const encoded = roles.map((value) => value.toString("hex"));
  if (encoded.some((value) => /^0+$/.test(value)) || new Set(encoded).size !== encoded.length) {
    throw new EscrowRulesHashError("INVALID_ROLES", "Escrow authority roles must be distinct non-zero public keys.");
  }
}

function u16(value: number, label: string): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > U16_MAX) {
    throw new EscrowRulesHashError("INVALID_INTEGER", "The " + label + " must fit in u16.");
  }
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u64(value: bigint, label: string): Buffer {
  if (value < 0n || value > U64_MAX) {
    throw new EscrowRulesHashError("INVALID_INTEGER", "The " + label + " must fit in u64.");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i64(value: bigint, label: string): Buffer {
  if (value < I64_MIN || value > I64_MAX) {
    throw new EscrowRulesHashError("INVALID_INTEGER", "The " + label + " must fit in i64.");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

export class EscrowRulesHashError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
