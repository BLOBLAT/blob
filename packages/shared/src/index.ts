export const BASIS_POINTS = 10_000n;
export const USDC_DECIMALS = 6;
export const USDC_BASE_UNITS = 1_000_000n;

/**
 * Paid matches use native USDC on Solana. The actual mint is a deployment
 * concern fixed by the escrow program configuration; it is deliberately not
 * accepted from a browser request.
 */
export const SettlementAsset = {
  NATIVE_SOLANA_USDC: "NATIVE_SOLANA_USDC"
} as const;

export type SettlementAsset = (typeof SettlementAsset)[keyof typeof SettlementAsset];

export const PaidRuleset = {
  SKILL: "SKILL",
  REBUY: "REBUY"
} as const;

export type PaidRuleset = (typeof PaidRuleset)[keyof typeof PaidRuleset];

export const PaidMatchState = {
  DRAFT: "DRAFT",
  OPEN: "OPEN",
  FUNDING: "FUNDING",
  READY: "READY",
  STARTING: "STARTING",
  LIVE: "LIVE",
  FINALIZING: "FINALIZING",
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED",
  REFUNDING: "REFUNDING",
  REFUNDED: "REFUNDED"
} as const;

export type PaidMatchState = (typeof PaidMatchState)[keyof typeof PaidMatchState];

export interface PrizeDistribution {
  place: number;
  basisPoints: bigint;
}

export interface PaidMatchConfiguration {
  ruleset: PaidRuleset;
  settlementAsset: SettlementAsset;
  entryAmountBaseUnits: bigint;
  platformFeeBps: bigint;
  prizeDistribution: readonly PrizeDistribution[];
  minimumPlayers: number;
  maximumPlayers: number;
  fundingTimeoutMs: number;
  refundRule: "IF_MATCH_DOES_NOT_START";
}

export const DEFAULT_PAID_MATCH_CONFIGURATION: PaidMatchConfiguration = {
  ruleset: PaidRuleset.SKILL,
  settlementAsset: SettlementAsset.NATIVE_SOLANA_USDC,
  entryAmountBaseUnits: USDC_BASE_UNITS,
  platformFeeBps: 500n,
  prizeDistribution: [
    { place: 1, basisPoints: 6_000n },
    { place: 2, basisPoints: 3_000n },
    { place: 3, basisPoints: 1_000n }
  ],
  minimumPlayers: 3,
  maximumPlayers: 10,
  fundingTimeoutMs: 300_000,
  refundRule: "IF_MATCH_DOES_NOT_START"
};

/**
 * Rebuy Arena is a separate disclosed ruleset. It is never silently enabled
 * for a standard Skill Match because an extra paid life changes competitive
 * conditions.
 */
export interface PaidReviveConfiguration {
  enabled: boolean;
  reviveAmountBaseUnits: bigint;
  maxRevivesPerPlayer: number;
  reviveWindowMs: number;
  reviveCutoffMs: number;
  spawnProtectionMs: number;
}

export const DEFAULT_REBUY_REVIVE_CONFIGURATION: PaidReviveConfiguration = {
  enabled: true,
  reviveAmountBaseUnits: 500_000n,
  maxRevivesPerPlayer: 1,
  reviveWindowMs: 30_000,
  reviveCutoffMs: 60_000,
  spawnProtectionMs: 1_500
};

export interface PrizePayout {
  place: number;
  amountBaseUnits: bigint;
}

export interface PrizeCalculation {
  grossPoolBaseUnits: bigint;
  platformFeeBaseUnits: bigint;
  prizePoolBaseUnits: bigint;
  payouts: PrizePayout[];
  roundingRemainderBaseUnits: bigint;
}

export interface PaidPoolInput {
  entryAmountBaseUnits: bigint;
  entryCount: number;
  reviveAmountBaseUnits: bigint;
  confirmedReviveCount: number;
}

export interface PaidPoolCalculation {
  entryPoolBaseUnits: bigint;
  revivePoolBaseUnits: bigint;
  grossPoolBaseUnits: bigint;
}

export interface PaidReviveEligibility {
  isPlayerDead: boolean;
  revivesUsed: number;
  remainingMs: number;
  millisecondsSinceDeath: number;
}

export const PaidReviveBlockReason = {
  ALLOWED: "ALLOWED",
  DISABLED: "DISABLED",
  PLAYER_IS_ALIVE: "PLAYER_IS_ALIVE",
  REVIVE_LIMIT_REACHED: "REVIVE_LIMIT_REACHED",
  REVIVE_WINDOW_EXPIRED: "REVIVE_WINDOW_EXPIRED",
  ROUND_CUTOFF_REACHED: "ROUND_CUTOFF_REACHED"
} as const;

export type PaidReviveBlockReason = (typeof PaidReviveBlockReason)[keyof typeof PaidReviveBlockReason];

/**
 * Returns the single server-enforced reason a Rebuy Arena player may not
 * purchase a revive. The browser may display this result but cannot grant a
 * respawn; the authoritative room also validates the issued permit.
 */
export function getPaidReviveEligibility(
  configuration: PaidReviveConfiguration,
  eligibility: PaidReviveEligibility
): PaidReviveBlockReason {
  assertReviveConfiguration(configuration);
  if (!configuration.enabled) {
    return PaidReviveBlockReason.DISABLED;
  }
  if (!eligibility.isPlayerDead) {
    return PaidReviveBlockReason.PLAYER_IS_ALIVE;
  }
  if (!Number.isSafeInteger(eligibility.revivesUsed) || eligibility.revivesUsed < 0 || eligibility.revivesUsed >= configuration.maxRevivesPerPlayer) {
    return PaidReviveBlockReason.REVIVE_LIMIT_REACHED;
  }
  if (!Number.isFinite(eligibility.remainingMs) || eligibility.remainingMs <= configuration.reviveCutoffMs) {
    return PaidReviveBlockReason.ROUND_CUTOFF_REACHED;
  }
  if (!Number.isFinite(eligibility.millisecondsSinceDeath) || eligibility.millisecondsSinceDeath < 0 || eligibility.millisecondsSinceDeath > configuration.reviveWindowMs) {
    return PaidReviveBlockReason.REVIVE_WINDOW_EXPIRED;
  }
  return PaidReviveBlockReason.ALLOWED;
}

export function calculatePaidMatchPool(input: PaidPoolInput): PaidPoolCalculation {
  assertContributionInput(input.entryAmountBaseUnits, input.entryCount, "entry");
  if (input.reviveAmountBaseUnits < 0n) {
    throw new RangeError("reviveAmountBaseUnits cannot be negative.");
  }
  if (!Number.isSafeInteger(input.confirmedReviveCount) || input.confirmedReviveCount < 0) {
    throw new RangeError("confirmedReviveCount must be a non-negative safe integer.");
  }
  const entryPoolBaseUnits = input.entryAmountBaseUnits * BigInt(input.entryCount);
  const revivePoolBaseUnits = input.reviveAmountBaseUnits * BigInt(input.confirmedReviveCount);
  return {
    entryPoolBaseUnits,
    revivePoolBaseUnits,
    grossPoolBaseUnits: entryPoolBaseUnits + revivePoolBaseUnits
  };
}

/**
 * Calculates a paid-match distribution in integer token base units only.
 * Division remainders are deterministically assigned to first place so no
 * base units become unaccounted for.
 */
export function calculatePrizeDistribution(input: Pick<PaidMatchConfiguration, "entryAmountBaseUnits" | "platformFeeBps" | "prizeDistribution"> & { playerCount: number }): PrizeCalculation {
  assertPrizeInput(input);
  return calculatePrizeDistributionFromGrossPool({
    grossPoolBaseUnits: input.entryAmountBaseUnits * BigInt(input.playerCount),
    platformFeeBps: input.platformFeeBps,
    prizeDistribution: input.prizeDistribution
  });
}

export function calculatePrizeDistributionFromGrossPool(input: Pick<PaidMatchConfiguration, "platformFeeBps" | "prizeDistribution"> & { grossPoolBaseUnits: bigint }): PrizeCalculation {
  if (input.grossPoolBaseUnits <= 0n) {
    throw new RangeError("grossPoolBaseUnits must be positive.");
  }
  assertPrizeInput({
    entryAmountBaseUnits: input.grossPoolBaseUnits,
    playerCount: 1,
    platformFeeBps: input.platformFeeBps,
    prizeDistribution: input.prizeDistribution
  });
  const platformFeeBaseUnits = (input.grossPoolBaseUnits * input.platformFeeBps) / BASIS_POINTS;
  const prizePoolBaseUnits = input.grossPoolBaseUnits - platformFeeBaseUnits;
  const payouts = input.prizeDistribution
    .slice()
    .sort((left, right) => left.place - right.place)
    .map((distribution) => ({
      place: distribution.place,
      amountBaseUnits: (prizePoolBaseUnits * distribution.basisPoints) / BASIS_POINTS
    }));
  const distributedBaseUnits = payouts.reduce((total, payout) => total + payout.amountBaseUnits, 0n);
  const roundingRemainderBaseUnits = prizePoolBaseUnits - distributedBaseUnits;

  if (payouts.length === 0) {
    throw new RangeError("At least one prize payout is required.");
  }
  payouts[0]!.amountBaseUnits += roundingRemainderBaseUnits;

  return {
    grossPoolBaseUnits: input.grossPoolBaseUnits,
    platformFeeBaseUnits,
    prizePoolBaseUnits,
    payouts,
    roundingRemainderBaseUnits
  };
}

export function canTransitionPaidMatch(from: PaidMatchState, to: PaidMatchState): boolean {
  return (PAID_MATCH_TRANSITIONS[from] ?? []).includes(to);
}

export function transitionPaidMatch(from: PaidMatchState, to: PaidMatchState): PaidMatchState {
  if (!canTransitionPaidMatch(from, to)) {
    throw new Error(`Invalid paid-match transition: ${from} -> ${to}`);
  }
  return to;
}

export interface EntryVerificationRequest {
  matchId: string;
  playerId: string;
  walletAddress: string;
  amountBaseUnits: bigint;
  idempotencyKey: string;
}

export interface VerifiedEntryPayment {
  paymentId: string;
  matchId: string;
  playerId: string;
  amountBaseUnits: bigint;
  transactionReference: string;
  idempotencyKey: string;
  verifiedAt: Date;
}

export interface PaidDeathEvent {
  deathId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  walletAddress: string;
  diedAt: Date;
  reviveExpiresAt: Date;
  reviveCutoffAt: Date;
}

/**
 * A one-time authorization issued only after the game server records an
 * authoritative death and the settlement service confirms the matching USDC
 * revive transaction. It is not a client-generated respawn request.
 */
export interface RevivePermit {
  permitId: string;
  matchId: string;
  roundId: string;
  playerId: string;
  walletAddress: string;
  deathId: string;
  paymentId: string;
  expiresAt: Date;
  idempotencyKey: string;
}

export interface VerifiedRevivePayment {
  paymentId: string;
  matchId: string;
  playerId: string;
  walletAddress: string;
  deathId: string;
  amountBaseUnits: bigint;
  transactionReference: string;
  idempotencyKey: string;
  verifiedAt: Date;
}

export interface FinalizedMatchResult {
  resultId: string;
  matchId: string;
  rankings: readonly { playerId: string; rank: number }[];
  finalizedAt: Date;
}

export interface MatchEntry {
  matchId: string;
  roundId: string;
  mode: "FREE" | "PAID";
  playerId: string;
  walletAddress?: string;
  enteredAt: Date;
}

export interface AuthoritativePlayerResult {
  playerId: string;
  walletAddress?: string;
  finalRank: number;
  finalMass: number;
  foodCollected: number;
  eliminations: number;
  deaths: number;
  survivalTimeMs: number;
}

/**
 * The game service can publish this immutable record after its authoritative
 * round is finalized. It does not initiate payment or blockchain transfers.
 */
export interface AuthoritativeMatchResult {
  matchId: string;
  roundId: string;
  mode: "FREE" | "PAID";
  resultTimestamp: Date;
  players: readonly AuthoritativePlayerResult[];
}

export interface SettlementRequest {
  settlementId: string;
  result: AuthoritativeMatchResult;
  payoutPlan: readonly PrizePayout[];
  idempotencyKey: string;
}

export interface SettlementResult {
  settlementId: string;
  transactionReferences: readonly string[];
  settledAt: Date;
}

export interface PayoutRequest {
  payoutId: string;
  resultId: string;
  playerId: string;
  amountBaseUnits: bigint;
  destinationWalletAddress: string;
  idempotencyKey: string;
}

/** Interfaces only: concrete chain or payment-provider adapters are not implemented in this sprint. */
export interface EntryPaymentVerifier {
  verifyEntry(request: EntryVerificationRequest): Promise<VerifiedEntryPayment>;
}

/** Interfaces only: every payout must use its own durable idempotency key. */
export interface PayoutSettlementGateway {
  requestPayout(request: PayoutRequest): Promise<{ transactionReference: string }>;
}

const PAID_MATCH_TRANSITIONS: Readonly<Record<PaidMatchState, readonly PaidMatchState[]>> = {
  [PaidMatchState.DRAFT]: [PaidMatchState.OPEN, PaidMatchState.CANCELLED],
  [PaidMatchState.OPEN]: [PaidMatchState.FUNDING, PaidMatchState.CANCELLED],
  [PaidMatchState.FUNDING]: [PaidMatchState.READY, PaidMatchState.REFUNDING, PaidMatchState.CANCELLED],
  [PaidMatchState.READY]: [PaidMatchState.STARTING, PaidMatchState.REFUNDING, PaidMatchState.CANCELLED],
  [PaidMatchState.STARTING]: [PaidMatchState.LIVE, PaidMatchState.REFUNDING, PaidMatchState.CANCELLED],
  [PaidMatchState.LIVE]: [PaidMatchState.FINALIZING, PaidMatchState.REFUNDING],
  [PaidMatchState.FINALIZING]: [PaidMatchState.SETTLED, PaidMatchState.REFUNDING],
  [PaidMatchState.SETTLED]: [],
  [PaidMatchState.CANCELLED]: [PaidMatchState.REFUNDING],
  [PaidMatchState.REFUNDING]: [PaidMatchState.REFUNDED],
  [PaidMatchState.REFUNDED]: []
};

function assertPrizeInput(input: Pick<PaidMatchConfiguration, "entryAmountBaseUnits" | "platformFeeBps" | "prizeDistribution"> & { playerCount: number }): void {
  if (!Number.isSafeInteger(input.playerCount) || input.playerCount < 1) {
    throw new RangeError("playerCount must be a positive safe integer.");
  }
  if (input.entryAmountBaseUnits <= 0n) {
    throw new RangeError("entryAmountBaseUnits must be positive.");
  }
  if (input.platformFeeBps < 0n || input.platformFeeBps > BASIS_POINTS) {
    throw new RangeError("platformFeeBps must be between 0 and 10000.");
  }
  const places = new Set<number>();
  let distributionTotal = 0n;
  for (const distribution of input.prizeDistribution) {
    if (!Number.isSafeInteger(distribution.place) || distribution.place < 1 || places.has(distribution.place)) {
      throw new RangeError("Prize places must be unique positive integers.");
    }
    if (distribution.basisPoints < 0n) {
      throw new RangeError("Prize basis points cannot be negative.");
    }
    places.add(distribution.place);
    distributionTotal += distribution.basisPoints;
  }
  if (distributionTotal !== BASIS_POINTS) {
    throw new RangeError("Prize distribution must total exactly 10000 basis points.");
  }
}

function assertContributionInput(amountBaseUnits: bigint, count: number, name: string): void {
  if (amountBaseUnits <= 0n) {
    throw new RangeError(name + "AmountBaseUnits must be positive.");
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(name + "Count must be a positive safe integer.");
  }
}

function assertReviveConfiguration(configuration: PaidReviveConfiguration): void {
  if (configuration.enabled && configuration.reviveAmountBaseUnits <= 0n) {
    throw new RangeError("reviveAmountBaseUnits must be positive when revive is enabled.");
  }
  if (!Number.isSafeInteger(configuration.maxRevivesPerPlayer) || configuration.maxRevivesPerPlayer < 0) {
    throw new RangeError("maxRevivesPerPlayer must be a non-negative safe integer.");
  }
  for (const [name, value] of Object.entries({
    reviveWindowMs: configuration.reviveWindowMs,
    reviveCutoffMs: configuration.reviveCutoffMs,
    spawnProtectionMs: configuration.spawnProtectionMs
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(name + " must be a positive finite number.");
    }
  }
}
