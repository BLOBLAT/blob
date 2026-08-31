import { createHash } from "node:crypto";
import { Point } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { hashEscrowIdentifier } from "./escrow-identifiers.js";

const UNDEPLOYED_PROGRAM_ID = "11111111111111111111111111111111";
const LEGACY_TOKEN_PROGRAM_ID = decodePublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "legacy token program");
const ASSOCIATED_TOKEN_PROGRAM_ID = decodePublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "associated token program");
const PROGRAM_DERIVED_ADDRESS_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const MAX_PDA_SEED_LENGTH = 32;
const MAX_PDA_SEEDS = 16;

export interface EscrowAddressPlan {
  programId: string;
  platformConfigAddress: string;
  matchEscrowAddress: string;
  escrowTokenAccountAddress: string;
  platformConfigBump: number;
  matchEscrowBump: number;
}

/**
 * Derives the exact program-owned accounts which the checked-in Anchor program
 * creates for a match. This is deterministic account planning only. The
 * algorithm is Solana's public PDA derivation: SHA-256 of the bounded seeds,
 * program bytes and `ProgramDerivedAddress`, retrying bumps until the result
 * is off the Ed25519 curve. It does not construct a transaction, contact an
 * RPC, or use any signing material.
 */
export function deriveEscrowAddressPlan(input: {
  programId: string;
  matchId: string;
  nativeUsdcMint: string;
}): EscrowAddressPlan {
  const programId = decodePublicKey(input.programId, "escrow program ID");
  if (input.programId === UNDEPLOYED_PROGRAM_ID) {
    throw new EscrowAddressError("PROGRAM_ID_UNDEPLOYED", "The escrow program ID has not been configured for deployment.");
  }
  const nativeUsdcMint = decodePublicKey(input.nativeUsdcMint, "native USDC mint");
  const matchIdHash = Buffer.from(hashEscrowIdentifier("match", input.matchId), "hex");
  const [platformConfig, platformConfigBump] = findProgramAddress(
    [Buffer.from("platform-config", "utf8")],
    programId
  );
  const [matchEscrow, matchEscrowBump] = findProgramAddress(
    [Buffer.from("match", "utf8"), matchIdHash],
    programId
  );
  const [escrowTokenAccount] = findProgramAddress(
    [matchEscrow, LEGACY_TOKEN_PROGRAM_ID, nativeUsdcMint],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return {
    programId: base58.encode(programId),
    platformConfigAddress: base58.encode(platformConfig),
    matchEscrowAddress: base58.encode(matchEscrow),
    escrowTokenAccountAddress: base58.encode(escrowTokenAccount),
    platformConfigBump,
    matchEscrowBump
  };
}

/** Validates and canonically re-encodes a 32-byte Solana public key. */
export function canonicalSolanaPublicKey(value: string, label = "Solana public key"): string {
  return base58.encode(decodePublicKey(value, label));
}

function findProgramAddress(seeds: readonly Uint8Array[], programId: Uint8Array): [Uint8Array, number] {
  if (seeds.length >= MAX_PDA_SEEDS) {
    throw new EscrowAddressError("PDA_SEEDS_INVALID", "Too many PDA seeds were supplied.");
  }
  for (let bump = 255; bump > 0; bump -= 1) {
    const candidate = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (candidate) {
      return [candidate, bump];
    }
  }
  throw new EscrowAddressError("PDA_DERIVATION_FAILED", "Could not derive an off-curve escrow PDA.");
}

function createProgramAddress(seeds: readonly Uint8Array[], programId: Uint8Array): Uint8Array | null {
  if (seeds.length > MAX_PDA_SEEDS) {
    throw new EscrowAddressError("PDA_SEEDS_INVALID", "Too many PDA seeds were supplied.");
  }
  for (const seed of seeds) {
    if (seed.length > MAX_PDA_SEED_LENGTH) {
      throw new EscrowAddressError("PDA_SEEDS_INVALID", "A PDA seed exceeds 32 bytes.");
    }
  }
  const candidate = createHash("sha256")
    .update(Buffer.concat([...seeds.map((seed) => Buffer.from(seed)), Buffer.from(programId), PROGRAM_DERIVED_ADDRESS_MARKER]))
    .digest();
  try {
    Point.fromBytes(candidate);
    return null;
  } catch {
    return Uint8Array.from(candidate);
  }
}

function decodePublicKey(value: string, label: string): Uint8Array {
  try {
    const decoded = base58.decode(value);
    if (decoded.length !== 32) {
      throw new Error("length");
    }
    return Uint8Array.from(decoded);
  } catch {
    throw new EscrowAddressError("PUBLIC_KEY_INVALID", "The " + label + " must be a valid Solana public key.");
  }
}

export class EscrowAddressError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
