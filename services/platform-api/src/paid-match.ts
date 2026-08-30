import { createHash, randomUUID } from "node:crypto";
import { base58 } from "@scure/base";
import {
  DEFAULT_PAID_MATCH_CONFIGURATION,
  DEFAULT_REBUY_REVIVE_CONFIGURATION,
  PaidReviveBlockReason,
  PaidRuleset,
  SettlementPayoutKind,
  SettlementAsset,
  assertPaidMatchConfiguration,
  assertPaidReviveConfiguration,
  calculatePaidMatchPool,
  calculatePrizeDistributionFromGrossPool,
  getPaidReviveEligibility,
  type AuthoritativeMatchResult,
  type PaidMatchConfiguration,
  type PaidPoolCalculation,
  type PaidReviveConfiguration,
  type PrizeCalculation,
  type SettlementPayout,
  type SettlementRequest
} from "@blob/shared";

export interface PaidMatchTerms {
  matchId: string;
  roundId: string;
  ruleset: PaidRuleset;
  settlementAsset: SettlementAsset;
  usdcMint: string;
  escrowAddress: string;
  rulesVersion: string;
  rulesHash: string;
  createdAt: Date;
  fundingDeadline: Date;
  configuration: PaidMatchConfiguration;
  reviveConfiguration: PaidReviveConfiguration;
}

export interface CreatePaidMatchTermsInput {
  usdcMint: string;
  escrowAddress: string;
  ruleset?: PaidRuleset;
  configuration?: PaidMatchConfiguration;
  reviveConfiguration?: PaidReviveConfiguration;
  now?: Date;
  fundingDeadline?: Date;
}

export interface VerifiedParticipant {
  playerId: string;
  walletAddress: string;
}

export interface ConfirmedRevive {
  playerId: string;
  deathId: string;
}

export interface FinalizedPaidMatch {
  immutableResultHash: string;
  pool: PaidPoolCalculation;
  prizes: PrizeCalculation;
  settlementRequest: SettlementRequest;
}

export interface ReviveOffer {
  reason: PaidReviveBlockReason;
  amountBaseUnits: bigint | null;
  expiresAt: Date | null;
}

/**
 * Creates the immutable terms which must be persisted before any entry is
 * accepted. This function never accepts terms from a browser request.
 */
export function createPaidMatchTerms(input: CreatePaidMatchTermsInput): PaidMatchTerms {
  assertSolanaAddress(input.usdcMint, "USDC mint");
  assertSolanaAddress(input.escrowAddress, "escrow address");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new PaidMatchDomainError("FUNDING_DEADLINE_INVALID", "Funding time is invalid.");
  }
  const ruleset = input.ruleset ?? input.configuration?.ruleset ?? PaidRuleset.SKILL;
  const configuration: PaidMatchConfiguration = {
    ...(input.configuration ?? DEFAULT_PAID_MATCH_CONFIGURATION),
    ruleset,
    settlementAsset: SettlementAsset.NATIVE_SOLANA_USDC,
    prizeDistribution: [...(input.configuration ?? DEFAULT_PAID_MATCH_CONFIGURATION).prizeDistribution]
  };
  const reviveConfiguration = ruleset === PaidRuleset.REBUY
    ? { ...(input.reviveConfiguration ?? DEFAULT_REBUY_REVIVE_CONFIGURATION) }
    : disabledReviveConfiguration();
  const fundingDeadline = input.fundingDeadline ?? new Date(now.getTime() + configuration.fundingTimeoutMs);
  if (!Number.isFinite(fundingDeadline.getTime()) || fundingDeadline <= now) {
    throw new PaidMatchDomainError("FUNDING_DEADLINE_INVALID", "Funding deadline must be in the future.");
  }
  if (fundingDeadline.getTime() > now.getTime() + configuration.fundingTimeoutMs) {
    throw new PaidMatchDomainError("FUNDING_DEADLINE_EXCEEDS_CONFIG", "Funding deadline exceeds the immutable funding window.");
  }
  assertEscrowCompatibleTerms(configuration, reviveConfiguration);
  const matchId = "paid-match-" + randomUUID();
  const roundId = "paid-round-" + randomUUID();
  const rulesHash = hashTerms({
    ruleset,
    usdcMint: input.usdcMint,
    escrowAddress: input.escrowAddress,
    fundingDeadline,
    configuration,
    reviveConfiguration
  });
  return {
    matchId,
    roundId,
    ruleset,
    settlementAsset: SettlementAsset.NATIVE_SOLANA_USDC,
    usdcMint: input.usdcMint,
    escrowAddress: input.escrowAddress,
    rulesVersion: "paid-rules-v3",
    rulesHash,
    createdAt: now,
    fundingDeadline,
    configuration,
    reviveConfiguration
  };
}

/**
 * Returns only an offer. A real respawn permit can be issued only after the
 * authoritative room reports this death and the chain adapter verifies USDC.
 */
export function getRebuyOffer(input: {
  terms: PaidMatchTerms;
  playerIsDead: boolean;
  revivesUsed: number;
  remainingMs: number;
  diedAt: Date;
  now: Date;
}): ReviveOffer {
  const reason = getPaidReviveEligibility(input.terms.reviveConfiguration, {
    isPlayerDead: input.playerIsDead,
    revivesUsed: input.revivesUsed,
    remainingMs: input.remainingMs,
    millisecondsSinceDeath: input.now.getTime() - input.diedAt.getTime()
  });
  if (reason !== PaidReviveBlockReason.ALLOWED) {
    return { reason, amountBaseUnits: null, expiresAt: null };
  }
  return {
    reason,
    amountBaseUnits: input.terms.reviveConfiguration.reviveAmountBaseUnits,
    expiresAt: new Date(Math.min(
      input.diedAt.getTime() + input.terms.reviveConfiguration.reviveWindowMs,
      input.now.getTime() + Math.max(0, input.remainingMs - input.terms.reviveConfiguration.reviveCutoffMs)
    ))
  };
}

/**
 * Converts a server-finalized result plus independently verified contributions
 * into an idempotent settlement request. It cannot sign or send a transfer.
 */
export function finalizePaidMatch(input: {
  terms: PaidMatchTerms;
  result: AuthoritativeMatchResult;
  verifiedParticipants: readonly VerifiedParticipant[];
  confirmedRevives: readonly ConfirmedRevive[];
  settlementId?: string;
}): FinalizedPaidMatch {
  assertEscrowCompatibleTerms(input.terms.configuration, input.terms.reviveConfiguration);
  if (input.result.mode !== "PAID" || input.result.matchId !== input.terms.matchId || input.result.roundId !== input.terms.roundId) {
    throw new PaidMatchDomainError("RESULT_MISMATCH", "Result does not belong to this paid match.");
  }
  assertVerifiedParticipants(input.verifiedParticipants, input.terms.configuration);
  assertResultMatchesParticipants(input.result, input.verifiedParticipants);
  assertConfirmedRevives(input.confirmedRevives, input.verifiedParticipants, input.terms.reviveConfiguration);

  const pool = calculatePaidMatchPool({
    entryAmountBaseUnits: input.terms.configuration.entryAmountBaseUnits,
    entryCount: input.verifiedParticipants.length,
    reviveAmountBaseUnits: input.terms.reviveConfiguration.enabled ? input.terms.reviveConfiguration.reviveAmountBaseUnits : 0n,
    confirmedReviveCount: input.confirmedRevives.length
  });
  const prizes = calculatePrizeDistributionFromGrossPool({
    grossPoolBaseUnits: pool.grossPoolBaseUnits,
    entryAmountBaseUnits: input.terms.configuration.entryAmountBaseUnits,
    playerCount: input.verifiedParticipants.length,
    platformFeeBps: input.terms.configuration.platformFeeBps,
    payoutDeliveryFeeBps: input.terms.configuration.payoutDeliveryFeeBps,
    participationRebateBps: input.terms.configuration.participationRebateBps,
    prizeDistribution: input.terms.configuration.prizeDistribution
  });
  const payoutPlan = buildSettlementPayoutPlan(input.result, prizes);
  const immutableResultHash = hashResult(input.result, input.verifiedParticipants, input.confirmedRevives, input.terms.rulesHash);
  // A retry must identify the same immutable result without relying on a
  // caller to remember a generated UUID. The resulting identifier is bounded
  // and contains no wallet or payment credential.
  const settlementId = input.settlementId ?? "settlement-" + immutableResultHash;
  assertInternalIdentifier(settlementId, "settlement ID");
  return {
    immutableResultHash,
    pool,
    prizes,
    settlementRequest: {
      settlementId,
      result: input.result,
      payoutPlan,
      idempotencyKey: "settle:" + input.terms.matchId + ":" + immutableResultHash
    }
  };
}

export class PaidMatchDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function disabledReviveConfiguration(): PaidReviveConfiguration {
  return {
    enabled: false,
    reviveAmountBaseUnits: 0n,
    maxRevivesPerPlayer: 0,
    reviveWindowMs: 0,
    reviveCutoffMs: 0,
    spawnProtectionMs: 0
  };
}

function assertEscrowCompatibleTerms(
  configuration: PaidMatchConfiguration,
  reviveConfiguration: PaidReviveConfiguration
): void {
  try {
    assertPaidMatchConfiguration(configuration);
    assertPaidReviveConfiguration(reviveConfiguration);
    if ((configuration.ruleset === PaidRuleset.REBUY) !== reviveConfiguration.enabled) {
      throw new RangeError("The selected ruleset and revive policy disagree.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paid match terms are invalid.";
    throw new PaidMatchDomainError("ESCROW_TERMS_INVALID", message);
  }
}

function assertVerifiedParticipants(participants: readonly VerifiedParticipant[], configuration: PaidMatchConfiguration): void {
  if (participants.length < configuration.minimumPlayers || participants.length > configuration.maximumPlayers) {
    throw new PaidMatchDomainError("ENTRY_COUNT_INVALID", "Verified entry count is outside match limits.");
  }
  const playerIds = new Set<string>();
  const wallets = new Set<string>();
  for (const participant of participants) {
    if (!isInternalIdentifier(participant.playerId) || playerIds.has(participant.playerId)) {
      throw new PaidMatchDomainError("ENTRY_DUPLICATE", "Each paid participant must be unique.");
    }
    assertSolanaAddress(participant.walletAddress, "participant wallet address");
    if (wallets.has(participant.walletAddress)) {
      throw new PaidMatchDomainError("WALLET_DUPLICATE", "A wallet may enter a paid match once.");
    }
    playerIds.add(participant.playerId);
    wallets.add(participant.walletAddress);
  }
}

function assertResultMatchesParticipants(result: AuthoritativeMatchResult, participants: readonly VerifiedParticipant[]): void {
  if (!isValidDate(result.resultTimestamp)) {
    throw new PaidMatchDomainError("RESULT_TIMESTAMP_INVALID", "Final result timestamp is invalid.");
  }
  if (!Array.isArray(result.players)) {
    throw new PaidMatchDomainError("RESULT_PARTICIPANT_COUNT_INVALID", "Final result does not include every verified entry.");
  }
  const participantIds = new Set(participants.map((participant) => participant.playerId));
  const playerIds = new Set<string>();
  const ranks = new Set<number>();
  if (result.players.length !== participants.length) {
    throw new PaidMatchDomainError("RESULT_PARTICIPANT_COUNT_INVALID", "Final result does not include every verified entry.");
  }
  for (const player of result.players) {
    if (!isInternalIdentifier(player.playerId)
      || !participantIds.has(player.playerId)
      || playerIds.has(player.playerId)
      || ranks.has(player.finalRank)
      || !isNonNegativeSafeInteger(player.finalRank)
      || player.finalRank < 1
      || !isNonNegativeSafeInteger(player.finalMass)
      || !isNonNegativeSafeInteger(player.foodCollected)
      || !isNonNegativeSafeInteger(player.eliminations)
      || !isNonNegativeSafeInteger(player.deaths)
      || !isNonNegativeSafeInteger(player.survivalTimeMs)) {
      throw new PaidMatchDomainError("RESULT_RANKING_INVALID", "Final result has an invalid paid ranking.");
    }
    playerIds.add(player.playerId);
    ranks.add(player.finalRank);
  }
  for (let rank = 1; rank <= participants.length; rank += 1) {
    if (!ranks.has(rank)) {
      throw new PaidMatchDomainError("RESULT_RANKING_INVALID", "Final result ranks must be contiguous.");
    }
  }
}

function assertConfirmedRevives(
  revives: readonly ConfirmedRevive[],
  participants: readonly VerifiedParticipant[],
  configuration: PaidReviveConfiguration
): void {
  if (!configuration.enabled && revives.length > 0) {
    throw new PaidMatchDomainError("REVIVE_NOT_ALLOWED", "Standard Skill matches cannot include paid revives.");
  }
  const participantIds = new Set(participants.map((participant) => participant.playerId));
  const revivesByPlayer = new Map<string, number>();
  const deathIds = new Set<string>();
  for (const revive of revives) {
    if (!isInternalIdentifier(revive.playerId)
      || !isInternalIdentifier(revive.deathId)
      || !participantIds.has(revive.playerId)
      || deathIds.has(revive.deathId)) {
      throw new PaidMatchDomainError("REVIVE_INVALID", "Confirmed revive does not belong to a unique paid death.");
    }
    deathIds.add(revive.deathId);
    const count = (revivesByPlayer.get(revive.playerId) ?? 0) + 1;
    if (count > configuration.maxRevivesPerPlayer) {
      throw new PaidMatchDomainError("REVIVE_LIMIT_EXCEEDED", "Confirmed revive count exceeds match rules.");
    }
    revivesByPlayer.set(revive.playerId, count);
  }
}

function hashTerms(input: {
  ruleset: PaidRuleset;
  usdcMint: string;
  escrowAddress: string;
  fundingDeadline: Date;
  configuration: PaidMatchConfiguration;
  reviveConfiguration: PaidReviveConfiguration;
}): string {
  return sha256(JSON.stringify({
    ruleset: input.ruleset,
    usdcMint: input.usdcMint,
    escrowAddress: input.escrowAddress,
    fundingDeadline: input.fundingDeadline.toISOString(),
    entryAmountBaseUnits: input.configuration.entryAmountBaseUnits.toString(),
    platformFeeBps: input.configuration.platformFeeBps.toString(),
    payoutDeliveryFeeBps: input.configuration.payoutDeliveryFeeBps.toString(),
    participationRebateBps: input.configuration.participationRebateBps.toString(),
    prizeDistribution: input.configuration.prizeDistribution.map((payout) => [payout.place, payout.basisPoints.toString()]),
    minimumPlayers: input.configuration.minimumPlayers,
    maximumPlayers: input.configuration.maximumPlayers,
    roundDurationMs: input.configuration.roundDurationMs,
    fundingTimeoutMs: input.configuration.fundingTimeoutMs,
    revive: {
      enabled: input.reviveConfiguration.enabled,
      reviveAmountBaseUnits: input.reviveConfiguration.reviveAmountBaseUnits.toString(),
      maxRevivesPerPlayer: input.reviveConfiguration.maxRevivesPerPlayer,
      reviveWindowMs: input.reviveConfiguration.reviveWindowMs,
      reviveCutoffMs: input.reviveConfiguration.reviveCutoffMs,
      spawnProtectionMs: input.reviveConfiguration.spawnProtectionMs
    }
  }));
}

/**
 * Converts the immutable rank list into an explicit recipient plan. The first
 * three ranks receive the configured prizes; all lower ranks receive only the
 * disclosed participation rebate. This contains no wallet address and does
 * not initiate a transfer.
 */
function buildSettlementPayoutPlan(
  result: AuthoritativeMatchResult,
  prizes: PrizeCalculation,
): SettlementPayout[] {
  const prizeByPlace = new Map(prizes.payouts.map((payout) => [payout.place, payout]));
  return [...result.players]
    .sort((left, right) => left.finalRank - right.finalRank)
    .map((player) => {
      const prize = prizeByPlace.get(player.finalRank);
      if (prize !== undefined) {
        return {
          playerId: player.playerId,
          finalRank: player.finalRank,
          kind: SettlementPayoutKind.PRIZE,
          place: player.finalRank,
          grossAmountBaseUnits: prize.grossAmountBaseUnits,
          deliveryFeeBaseUnits: prize.deliveryFeeBaseUnits,
          amountBaseUnits: prize.amountBaseUnits,
        };
      }
      return {
        playerId: player.playerId,
        finalRank: player.finalRank,
          kind: SettlementPayoutKind.PARTICIPATION_REBATE,
          place: null,
          grossAmountBaseUnits: prizes.participationRebatePerPlayerBaseUnits,
          deliveryFeeBaseUnits: 0n,
          amountBaseUnits: prizes.participationRebatePerPlayerBaseUnits,
      };
    });
}

function hashResult(
  result: AuthoritativeMatchResult,
  participants: readonly VerifiedParticipant[],
  revives: readonly ConfirmedRevive[],
  rulesHash: string
): string {
  return sha256(JSON.stringify({
    rulesHash,
    matchId: result.matchId,
    roundId: result.roundId,
    resultTimestamp: result.resultTimestamp.toISOString(),
    players: [...result.players]
      .sort((left, right) => left.finalRank - right.finalRank)
      .map((player) => [player.playerId, player.finalRank, player.finalMass, player.foodCollected, player.eliminations, player.deaths, player.survivalTimeMs]),
    participants: [...participants].sort((left, right) => left.playerId.localeCompare(right.playerId)),
    revives: [...revives].sort((left, right) => left.deathId.localeCompare(right.deathId))
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSolanaAddress(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new PaidMatchDomainError("SOLANA_ADDRESS_INVALID", "The " + label + " is invalid.");
  }
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(value);
  } catch {
    throw new PaidMatchDomainError("SOLANA_ADDRESS_INVALID", "The " + label + " is invalid.");
  }
  if (decoded.length !== 32) {
    throw new PaidMatchDomainError("SOLANA_ADDRESS_INVALID", "The " + label + " is invalid.");
  }
}

function assertInternalIdentifier(value: unknown, label: string): asserts value is string {
  if (!isInternalIdentifier(value)) {
    throw new PaidMatchDomainError("SETTLEMENT_ID_INVALID", "The " + label + " is invalid.");
  }
}

function isInternalIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isSafeInteger(value.getTime());
}
