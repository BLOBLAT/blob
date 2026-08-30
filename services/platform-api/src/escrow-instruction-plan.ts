import { createHash } from "node:crypto";
import {
  PaidRuleset,
  assertPaidMatchConfiguration,
  assertPaidReviveConfiguration,
  type PaidMatchConfiguration,
  type PaidReviveConfiguration
} from "@blob/shared";
import { createEscrowRulesHash } from "./escrow-rules-hash.js";
import type { PaidMatchTerms } from "./paid-match.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Resolved only inside the future controlled escrow orchestration service. */
export interface EscrowAuthorityRoles {
  platformAuthority: string;
  matchController: string;
  resultAuthority: string;
  treasury: string;
}

/**
 * Exact immutable inputs expected by the program's future `create_match`
 * instruction. This is a data plan, not an Anchor client and not a Solana
 * transaction request.
 */
export interface EscrowCreateMatchPlan {
  matchIdHash: string;
  roundIdHash: string;
  onchainRulesHash: string;
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

/**
 * Creates a canonical, auditable hand-off from durable off-chain terms to the
 * on-chain escrow instruction. It is intentionally server-only: neither the
 * browser nor the Colyseus game server receives authority role keys or this
 * plan.
 */
export function createEscrowCreateMatchPlan(
  terms: PaidMatchTerms,
  roles: EscrowAuthorityRoles
): EscrowCreateMatchPlan {
  assertTermsCanBeCommitted(terms);
  const matchIdHash = hashEscrowIdentifier("match", terms.matchId);
  const roundIdHash = hashEscrowIdentifier("round", terms.roundId);
  const configuration = terms.configuration;
  const reviveConfiguration = terms.reviveConfiguration;
  const payoutBps = payoutBasisPoints(configuration);
  const fundingDeadlineUnixSeconds = dateToExactUnixSeconds(terms.fundingDeadline, "funding deadline");
  const roundDurationSeconds = millisecondsToExactSeconds(configuration.roundDurationMs, "round duration");
  const reviveWindowSeconds = millisecondsToExactSeconds(reviveConfiguration.reviveWindowMs, "revive window");
  const reviveCutoffSeconds = millisecondsToExactSeconds(reviveConfiguration.reviveCutoffMs, "revive cutoff");

  return {
    matchIdHash,
    roundIdHash,
    onchainRulesHash: createEscrowRulesHash({
      matchIdHash,
      roundIdHash,
      nativeUsdcMint: terms.usdcMint,
      platformAuthority: roles.platformAuthority,
      matchController: roles.matchController,
      resultAuthority: roles.resultAuthority,
      treasury: roles.treasury,
      entryAmountBaseUnits: configuration.entryAmountBaseUnits,
      payoutDeliveryFeeBps: Number(configuration.payoutDeliveryFeeBps),
      reviveEnabled: reviveConfiguration.enabled,
      reviveAmountBaseUnits: reviveConfiguration.reviveAmountBaseUnits,
      participationRebateBps: Number(configuration.participationRebateBps),
      payoutBps,
      minimumPlayers: configuration.minimumPlayers,
      maximumPlayers: configuration.maximumPlayers,
      fundingDeadlineUnixSeconds,
      roundDurationSeconds,
      reviveWindowSeconds,
      reviveCutoffSeconds
    }),
    entryAmountBaseUnits: configuration.entryAmountBaseUnits,
    payoutDeliveryFeeBps: Number(configuration.payoutDeliveryFeeBps),
    reviveEnabled: reviveConfiguration.enabled,
    reviveAmountBaseUnits: reviveConfiguration.reviveAmountBaseUnits,
    participationRebateBps: Number(configuration.participationRebateBps),
    payoutBps,
    minimumPlayers: configuration.minimumPlayers,
    maximumPlayers: configuration.maximumPlayers,
    fundingDeadlineUnixSeconds,
    roundDurationSeconds,
    reviveWindowSeconds,
    reviveCutoffSeconds
  };
}

/** Domain-separated hash for the program's opaque 32-byte match/round PDA seeds. */
export function hashEscrowIdentifier(kind: "match" | "round", identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new EscrowInstructionPlanError("IDENTIFIER_INVALID", "The " + kind + " identifier is invalid.");
  }
  return createHash("sha256")
    .update("blob-escrow-" + kind + "-id-v1\0", "utf8")
    .update(identifier, "utf8")
    .digest("hex");
}

function assertTermsCanBeCommitted(terms: PaidMatchTerms): void {
  try {
    assertPaidMatchConfiguration(terms.configuration);
    assertPaidReviveConfiguration(terms.reviveConfiguration);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paid match terms are invalid.";
    throw new EscrowInstructionPlanError("TERMS_INVALID", message);
  }
  if (terms.ruleset !== terms.configuration.ruleset
    || (terms.ruleset === PaidRuleset.REBUY) !== terms.reviveConfiguration.enabled) {
    throw new EscrowInstructionPlanError("TERMS_INVALID", "The ruleset and revive policy disagree.");
  }
}

function payoutBasisPoints(configuration: PaidMatchConfiguration): [number, number, number] {
  const byPlace = new Map(configuration.prizeDistribution.map((value) => [value.place, value.basisPoints]));
  const values = [byPlace.get(1), byPlace.get(2), byPlace.get(3)];
  if (values.some((value) => value === undefined || value! > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new EscrowInstructionPlanError("TERMS_INVALID", "The payout distribution cannot be committed.");
  }
  return values.map((value) => Number(value)) as [number, number, number];
}

function dateToExactUnixSeconds(value: Date, label: string): bigint {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1_000 !== 0) {
    throw new EscrowInstructionPlanError("TIMESTAMP_INVALID", "The " + label + " must have whole-second precision.");
  }
  return BigInt(milliseconds / 1_000);
}

function millisecondsToExactSeconds(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value % 1_000 !== 0) {
    throw new EscrowInstructionPlanError("TERMS_INVALID", "The " + label + " must have whole-second precision.");
  }
  return BigInt(value / 1_000);
}

export class EscrowInstructionPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
