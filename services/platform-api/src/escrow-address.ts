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

/** Addresses required for one enrolled player's immutable MatchEntry PDA. */
export interface EscrowEntryAddressPlan {
  programId: string;
  matchEscrowAddress: string;
  entryAddress: string;
  playerTokenAccountAddress: string;
  entryBump: number;
}

/** Addresses required for one authority-attested Rebuy receipt PDA. */
export interface EscrowReviveAddressPlan {
  programId: string;
  matchEscrowAddress: string;
  entryAddress: string;
  playerTokenAccountAddress: string;
  reviveReceiptAddress: string;
  entryBump: number;
  reviveReceiptBump: number;
  deathIdHash: string;
}

/** Derives a standard legacy-token associated account with no RPC lookup. */
export function deriveAssociatedTokenAccountAddress(input: {
  ownerAddress: string;
  nativeUsdcMint: string;
}): string {
  const owner = decodePublicKey(input.ownerAddress, "token account owner");
  const nativeUsdcMint = decodePublicKey(input.nativeUsdcMint, "native USDC mint");
  const [tokenAccount] = findProgramAddress(
    [owner, LEGACY_TOKEN_PROGRAM_ID, nativeUsdcMint],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return base58.encode(tokenAccount);
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
  const programId = decodeDeployedEscrowProgramId(input.programId);
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

/**
 * Derives the only MatchEntry PDA and standard native-USDC ATA accepted by
 * the browser-facing entry flow. It is account planning only: no instruction,
 * signature, RPC request, or token transfer is created here.
 */
export function deriveEscrowEntryAddressPlan(input: {
  programId: string;
  matchEscrowAddress: string;
  playerAddress: string;
  nativeUsdcMint: string;
}): EscrowEntryAddressPlan {
  const programId = decodeDeployedEscrowProgramId(input.programId);
  const matchEscrow = decodePublicKey(input.matchEscrowAddress, "match escrow PDA");
  const player = decodePublicKey(input.playerAddress, "player wallet address");
  const nativeUsdcMint = decodePublicKey(input.nativeUsdcMint, "native USDC mint");
  const [entry, entryBump] = findProgramAddress(
    [Buffer.from("entry", "utf8"), matchEscrow, player],
    programId
  );
  return {
    programId: base58.encode(programId),
    matchEscrowAddress: base58.encode(matchEscrow),
    entryAddress: base58.encode(entry),
    playerTokenAccountAddress: deriveAssociatedTokenAccountAddress({
      ownerAddress: base58.encode(player),
      nativeUsdcMint: base58.encode(nativeUsdcMint),
    }),
    entryBump,
  };
}

/**
 * Derives the unique Rebuy receipt PDA from a domain-separated authoritative
 * death ID. This is public account planning only; it cannot authorize a
 * revive, create a transaction, or send USDC.
 */
export function deriveEscrowReviveAddressPlan(input: {
  programId: string;
  matchEscrowAddress: string;
  playerAddress: string;
  nativeUsdcMint: string;
  deathId: string;
}): EscrowReviveAddressPlan {
  const entry = deriveEscrowEntryAddressPlan(input);
  const programId = decodeDeployedEscrowProgramId(input.programId);
  const matchEscrow = decodePublicKey(input.matchEscrowAddress, "match escrow PDA");
  const deathIdHash = hashEscrowIdentifier("death", input.deathId);
  const [reviveReceipt, reviveReceiptBump] = findProgramAddress(
    [Buffer.from("revive", "utf8"), matchEscrow, Buffer.from(deathIdHash, "hex")],
    programId
  );
  return {
    ...entry,
    reviveReceiptAddress: base58.encode(reviveReceipt),
    reviveReceiptBump,
    deathIdHash,
  };
}

/** Validates and canonically re-encodes a 32-byte Solana public key. */
export function canonicalSolanaPublicKey(value: string, label = "Solana public key"): string {
  return base58.encode(decodePublicKey(value, label));
}

function decodeDeployedEscrowProgramId(value: string): Uint8Array {
  const programId = decodePublicKey(value, "escrow program ID");
  if (base58.encode(programId) === UNDEPLOYED_PROGRAM_ID) {
    throw new EscrowAddressError("PROGRAM_ID_UNDEPLOYED", "The escrow program ID has not been configured for deployment.");
  }
  return programId;
}

function findProgramAddress(seeds: readonly Uint8Array[], programId: Uint8Array): [Uint8Array, number] {
  if (seeds.length >= MAX_PDA_SEEDS) {
    throw new EscrowAddressError("PDA_SEEDS_INVALID", "Too many PDA seeds were supplied.");
  }
  // Solana searches the complete u8 bump range, including zero. Omitting
  // zero would make a small subset of valid PDA seed combinations fail only
  // in production, so keep this loop byte-for-byte equivalent to the runtime.
  for (let bump = 255; bump >= 0; bump -= 1) {
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
