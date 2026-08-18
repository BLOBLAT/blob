export const BASIS_POINTS = 10_000n;

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
  entryAmountBaseUnits: bigint;
  platformFeeBps: bigint;
  prizeDistribution: readonly PrizeDistribution[];
  minimumPlayers: number;
  maximumPlayers: number;
  fundingTimeoutMs: number;
  refundRule: "IF_MATCH_DOES_NOT_START";
}

export const DEFAULT_PAID_MATCH_CONFIGURATION: PaidMatchConfiguration = {
  entryAmountBaseUnits: 1_000_000n,
  platformFeeBps: 500n,
  prizeDistribution: [
    { place: 1, basisPoints: 6_000n },
    { place: 2, basisPoints: 2_500n },
    { place: 3, basisPoints: 1_500n }
  ],
  minimumPlayers: 3,
  maximumPlayers: 10,
  fundingTimeoutMs: 300_000,
  refundRule: "IF_MATCH_DOES_NOT_START"
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

/**
 * Calculates a paid-match distribution in integer token base units only.
 * Division remainders are deterministically assigned to first place so no
 * base units become unaccounted for.
 */
export function calculatePrizeDistribution(input: Pick<PaidMatchConfiguration, "entryAmountBaseUnits" | "platformFeeBps" | "prizeDistribution"> & { playerCount: number }): PrizeCalculation {
  assertPrizeInput(input);
  const grossPoolBaseUnits = input.entryAmountBaseUnits * BigInt(input.playerCount);
  const platformFeeBaseUnits = (grossPoolBaseUnits * input.platformFeeBps) / BASIS_POINTS;
  const prizePoolBaseUnits = grossPoolBaseUnits - platformFeeBaseUnits;
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
    grossPoolBaseUnits,
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

export interface FinalizedMatchResult {
  resultId: string;
  matchId: string;
  rankings: readonly { playerId: string; rank: number }[];
  finalizedAt: Date;
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
