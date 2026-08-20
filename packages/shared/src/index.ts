export const BASIS_POINTS = 10_000n;
export const USDC_DECIMALS = 6;
export const USDC_BASE_UNITS = 1_000_000n;
export const PAID_MATCH_PLATFORM_FEE_BPS = 500n;
export const PAID_MATCH_WINNER_COUNT = 3;
export const PAID_MATCH_MAX_PLAYERS = 32;
export const PAID_MATCH_ROUND_DURATION_MS = 10 * 60 * 1_000;
/**
 * Funds must not remain in a pre-game escrow indefinitely. This cap is shared
 * with the escrow program's permissionless funding-expiry path.
 */
export const PAID_MATCH_MAX_FUNDING_TIMEOUT_MS = 15 * 60 * 1_000;
export const REBUY_AMOUNT_BASE_UNITS = 500_000n;
export const REBUY_WINDOW_MS = 30_000;
export const REBUY_CUTOFF_MS = 60_000;
export const REBUY_SPAWN_PROTECTION_MS = 1_500;

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
  roundDurationMs: number;
  fundingTimeoutMs: number;
  refundRule: "IF_MATCH_DOES_NOT_START";
}

export const DEFAULT_PAID_MATCH_CONFIGURATION: PaidMatchConfiguration = {
  ruleset: PaidRuleset.SKILL,
  settlementAsset: SettlementAsset.NATIVE_SOLANA_USDC,
  entryAmountBaseUnits: USDC_BASE_UNITS,
  platformFeeBps: PAID_MATCH_PLATFORM_FEE_BPS,
  prizeDistribution: [
    { place: 1, basisPoints: 6_000n },
    { place: 2, basisPoints: 3_000n },
    { place: 3, basisPoints: 1_000n }
  ],
  minimumPlayers: 3,
  maximumPlayers: 10,
  roundDurationMs: PAID_MATCH_ROUND_DURATION_MS,
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
  reviveAmountBaseUnits: REBUY_AMOUNT_BASE_UNITS,
  maxRevivesPerPlayer: 1,
  reviveWindowMs: REBUY_WINDOW_MS,
  reviveCutoffMs: REBUY_CUTOFF_MS,
  spawnProtectionMs: REBUY_SPAWN_PROTECTION_MS
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
  assertPaidReviveConfiguration(configuration);
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
  if (!Number.isSafeInteger(input.confirmedReviveCount) || input.confirmedReviveCount < 0) {
    throw new RangeError("confirmedReviveCount must be a non-negative safe integer.");
  }
  if (input.confirmedReviveCount > 0 && input.reviveAmountBaseUnits <= 0n) {
    throw new RangeError("reviveAmountBaseUnits must be positive when revives are confirmed.");
  }
  if (input.confirmedReviveCount === 0 && input.reviveAmountBaseUnits < 0n) {
    throw new RangeError("reviveAmountBaseUnits cannot be negative.");
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

/**
 * Validates paid terms before they are persisted or an entry is accepted.
 * These constraints intentionally mirror the checked-in native-USDC escrow:
 * three prizes, a fixed 5% fee, at most 32 entrants, and a ten-minute round.
 */
export function assertPaidMatchConfiguration(configuration: PaidMatchConfiguration): void {
  if (configuration.ruleset !== PaidRuleset.SKILL && configuration.ruleset !== PaidRuleset.REBUY) {
    throw new RangeError("ruleset must be SKILL or REBUY.");
  }
  if (configuration.settlementAsset !== SettlementAsset.NATIVE_SOLANA_USDC) {
    throw new RangeError("Only native Solana USDC is supported.");
  }
  if (!Number.isSafeInteger(configuration.minimumPlayers)
    || !Number.isSafeInteger(configuration.maximumPlayers)
    || configuration.minimumPlayers < PAID_MATCH_WINNER_COUNT
    || configuration.maximumPlayers < configuration.minimumPlayers
    || configuration.maximumPlayers > PAID_MATCH_MAX_PLAYERS) {
    throw new RangeError("Paid match player limits are invalid.");
  }
  if (!Number.isSafeInteger(configuration.roundDurationMs) || configuration.roundDurationMs !== PAID_MATCH_ROUND_DURATION_MS) {
    throw new RangeError("Paid match roundDurationMs must match the current ten-minute ruleset.");
  }
  if (!Number.isSafeInteger(configuration.fundingTimeoutMs)
    || configuration.fundingTimeoutMs <= 0
    || configuration.fundingTimeoutMs > PAID_MATCH_MAX_FUNDING_TIMEOUT_MS) {
    throw new RangeError("Paid match fundingTimeoutMs must be a positive safe integer within the funding window.");
  }
  assertPrizeInput({
    entryAmountBaseUnits: configuration.entryAmountBaseUnits,
    playerCount: configuration.minimumPlayers,
    platformFeeBps: configuration.platformFeeBps,
    prizeDistribution: configuration.prizeDistribution
  });
}

/**
 * Disabled Skill-match revive values are canonical zeros. Rebuy Arena has one
 * fixed 0.50 USDC revive and the disclosed 30-second/final-minute timing.
 */
export function assertPaidReviveConfiguration(configuration: PaidReviveConfiguration): void {
  const numericFields = [
    configuration.maxRevivesPerPlayer,
    configuration.reviveWindowMs,
    configuration.reviveCutoffMs,
    configuration.spawnProtectionMs
  ];
  if (!numericFields.every(Number.isSafeInteger) || numericFields.some((value) => value < 0)) {
    throw new RangeError("Paid revive configuration contains an invalid numeric value.");
  }
  if (!configuration.enabled) {
    if (configuration.reviveAmountBaseUnits !== 0n
      || configuration.maxRevivesPerPlayer !== 0
      || configuration.reviveWindowMs !== 0
      || configuration.reviveCutoffMs !== 0
      || configuration.spawnProtectionMs !== 0) {
      throw new RangeError("Disabled paid revive configuration must use canonical zero values.");
    }
    return;
  }
  if (configuration.reviveAmountBaseUnits !== REBUY_AMOUNT_BASE_UNITS
    || configuration.maxRevivesPerPlayer !== 1
    || configuration.reviveWindowMs !== REBUY_WINDOW_MS
    || configuration.reviveCutoffMs !== REBUY_CUTOFF_MS
    || configuration.spawnProtectionMs !== REBUY_SPAWN_PROTECTION_MS) {
    throw new RangeError("Paid revive configuration does not match the current Rebuy Arena ruleset.");
  }
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
  // A refund is a pre-game funding failure path. It cannot replace an
  // already-live round's result; the escrow program enforces the same rule.
  [PaidMatchState.FUNDING]: [PaidMatchState.READY, PaidMatchState.REFUNDING],
  [PaidMatchState.READY]: [PaidMatchState.STARTING, PaidMatchState.REFUNDING],
  [PaidMatchState.STARTING]: [PaidMatchState.LIVE, PaidMatchState.REFUNDING],
  [PaidMatchState.LIVE]: [PaidMatchState.FINALIZING],
  [PaidMatchState.FINALIZING]: [PaidMatchState.SETTLED],
  [PaidMatchState.SETTLED]: [],
  [PaidMatchState.CANCELLED]: [],
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
  if (input.platformFeeBps !== PAID_MATCH_PLATFORM_FEE_BPS) {
    throw new RangeError("platformFeeBps must be the fixed 5% platform fee.");
  }
  assertThreePlacePrizeDistribution(input.prizeDistribution);
}

function assertContributionInput(amountBaseUnits: bigint, count: number, name: string): void {
  if (amountBaseUnits <= 0n) {
    throw new RangeError(name + "AmountBaseUnits must be positive.");
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(name + "Count must be a positive safe integer.");
  }
}

function assertThreePlacePrizeDistribution(prizeDistribution: readonly PrizeDistribution[]): void {
  if (prizeDistribution.length !== PAID_MATCH_WINNER_COUNT) {
    throw new RangeError("Paid matches must have exactly three prize places.");
  }
  let distributionTotal = 0n;
  for (const [index, distribution] of prizeDistribution.entries()) {
    if (!Number.isSafeInteger(distribution.place) || distribution.place !== index + 1) {
      throw new RangeError("Prize places must be exactly 1, 2, and 3.");
    }
    if (typeof distribution.basisPoints !== "bigint" || distribution.basisPoints <= 0n) {
      throw new RangeError("Prize basis points must be positive integers.");
    }
    distributionTotal += distribution.basisPoints;
  }
  if (distributionTotal !== BASIS_POINTS) {
    throw new RangeError("Prize distribution must total exactly 10000 basis points.");
  }
}
