import { describe, expect, it } from "vitest";
import { PaidRuleset, SettlementPayoutKind, type AuthoritativeMatchResult } from "@blob/shared";
import { createPaidMatchTerms, type PaidMatchTerms, type VerifiedParticipant } from "./paid-match.js";
import {
  PaidMatchPersistenceError,
  PrismaPaidMatchFinalizationRepository,
} from "./paid-match-finalization-repository.js";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";

const NOW = new Date("2026-08-24T10:00:00.000Z");
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ESCROW_PROGRAM_ID = "Stake11111111111111111111111111111111111111";
const WALLETS = [
  "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC",
  "7YttLkH3UQJfB73uExyGfEKvwR6LjhQmN6x2PRZKMrP2",
  "B6xXoQkbXZp27DiNUZCr36N54xe69Bp5uzWUsWeLMYqV",
  "So11111111111111111111111111111111111111112",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111"
];

describe("durable paid-match finalization", () => {
  it("persists one immutable result, payout plan, and settlement record without wallet data in result payload", async () => {
    const terms = createTerms();
    const state = createState(terms);
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));
    const input = createInput(terms);

    const first = await repository.persist(input);
    const retried = await repository.persist(input);

    expect(first).toMatchObject({ created: true, resultId: "result-1" });
    expect(retried).toEqual({ ...first, created: false });
    expect(state.result).toMatchObject({
      matchId: terms.matchId,
      roundId: terms.roundId,
      rulesHash: terms.rulesHash,
      resultHash: first.immutableResultHash,
    });
    expect(JSON.stringify(state.result?.resultPayload)).not.toContain(WALLETS[0]!);
    expect(state.attempt).toMatchObject({
      resultId: "result-1",
      resultHash: first.immutableResultHash,
      settlementId: first.settlementId,
    });
    expect(state.payouts.map((payout) => [payout.kind, payout.place, payout.entryId])).toEqual([
      [SettlementPayoutKind.PRIZE, 1, "entry-1"],
      [SettlementPayoutKind.PRIZE, 2, "entry-2"],
      [SettlementPayoutKind.PRIZE, 3, "entry-3"],
      [SettlementPayoutKind.PARTICIPATION_REBATE, null, "entry-4"],
      [SettlementPayoutKind.PARTICIPATION_REBATE, null, "entry-5"],
      [SettlementPayoutKind.PARTICIPATION_REBATE, null, "entry-6"],
    ]);
    expect(state.match.status).toBe("FINALIZING");
    expect(state.auditEvents).toHaveLength(1);
  });

  it("rejects a divergent result instead of replacing an immutable finalization", async () => {
    const terms = createTerms();
    const state = createState(terms);
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));
    const input = createInput(terms);
    await repository.persist(input);

    const divergent: AuthoritativeMatchResult = {
      ...input.result,
      players: [{ ...input.result.players[0]!, finalMass: 999 }, ...input.result.players.slice(1)]
    };
    await expect(repository.persist({ ...input, result: divergent }))
      .rejects.toMatchObject({ code: "RESULT_IMMUTABLE_CONFLICT" } satisfies Partial<PaidMatchPersistenceError>);
  });

  it("requires a verified entry bound to each server result participant", async () => {
    const terms = createTerms();
    const state = createState(terms);
    state.entries[1]!.wallet.address = WALLETS[0]!;
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));

    await expect(repository.persist(createInput(terms)))
      .rejects.toMatchObject({ code: "ENTRY_BINDING_INVALID" } satisfies Partial<PaidMatchPersistenceError>);
    expect(state.result).toBeUndefined();
    expect(state.attempt).toBeUndefined();
  });

  it("retains a consumed one-time admission entry as a valid finalization participant", async () => {
    const terms = createTerms();
    const state = createState(terms);
    state.entries[0]!.status = "CONSUMED";
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));

    await expect(repository.persist(createInput(terms))).resolves.toMatchObject({ created: true });
  });

  it("refuses to freeze a result before the paid match has entered a finalizable lifecycle state", async () => {
    const terms = createTerms();
    const state = createState(terms);
    state.match.status = "FUNDING";
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));

    await expect(repository.persist(createInput(terms)))
      .rejects.toMatchObject({ code: "MATCH_NOT_FINALIZABLE" } satisfies Partial<PaidMatchPersistenceError>);
  });

  it("requires a durable start and a result no earlier than the full authoritative round", async () => {
    const terms = createTerms();
    const state = createState(terms);
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));

    state.match.startsAt = null;
    await expect(repository.persist(createInput(terms)))
      .rejects.toMatchObject({ code: "RESULT_TIMING_INVALID" } satisfies Partial<PaidMatchPersistenceError>);

    state.match.startsAt = new Date(NOW.getTime() - 599_999);
    await expect(repository.persist(createInput(terms)))
      .rejects.toMatchObject({ code: "RESULT_TIMING_INVALID" } satisfies Partial<PaidMatchPersistenceError>);

    state.match.startsAt = new Date(NOW.getTime() - 600_000);
    await expect(repository.persist(createInput(terms))).resolves.toMatchObject({ created: true });
  });

  it("rejects a result timestamp in the future", async () => {
    const terms = createTerms();
    const state = createState(terms);
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));
    state.match.startsAt = new Date(Date.now() - 600_000);
    const input = createInput(terms);
    input.result = { ...input.result, resultTimestamp: new Date(Date.now() + 60_000) };

    await expect(repository.persist(input))
      .rejects.toMatchObject({ code: "RESULT_TIMING_INVALID" } satisfies Partial<PaidMatchPersistenceError>);
  });

  it("retries one serializable-write conflict before freezing the same result", async () => {
    const terms = createTerms();
    const state = createState(terms);
    state.serializationFailures = 1;
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));

    await expect(repository.persist(createInput(terms))).resolves.toMatchObject({ created: true });
    expect(state.transactionCalls).toBe(2);
    expect(state.isolationLevels).toEqual([
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable,
    ]);
  });

  it("fails closed when an existing payout record differs from the immutable payout plan", async () => {
    const terms = createTerms();
    const state = createState(terms);
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));
    const input = createInput(terms);
    await repository.persist(input);
    state.payouts[0]!.amountBaseUnits += 1n;

    await expect(repository.persist(input))
      .rejects.toMatchObject({ code: "PAYOUT_RECORD_CONFLICT" } satisfies Partial<PaidMatchPersistenceError>);
  });

  it("fails closed when an existing payout set omits a prize place", async () => {
    const terms = createTerms();
    const state = createState(terms);
    const repository = new PrismaPaidMatchFinalizationRepository(createPrisma(state));
    const input = createInput(terms);
    await repository.persist(input);
    state.payouts[3] = { ...state.payouts[0]! };

    await expect(repository.persist(input))
      .rejects.toMatchObject({ code: "PAYOUT_RECORD_CONFLICT" } satisfies Partial<PaidMatchPersistenceError>);
  });
});

function createTerms(): PaidMatchTerms {
  return createPaidMatchTerms({
    usdcMint: USDC_MINT,
    escrowProgramId: ESCROW_PROGRAM_ID,
    ruleset: PaidRuleset.SKILL,
    now: NOW,
  });
}

function createInput(terms: PaidMatchTerms) {
  return {
    terms,
    result: createResult(terms.matchId, terms.roundId),
    verifiedParticipants: participants(),
    confirmedRevives: [],
  };
}

function participants(): VerifiedParticipant[] {
  return WALLETS.map((walletAddress, index) => ({ playerId: "player-" + (index + 1), walletAddress }));
}

function createResult(matchId: string, roundId: string): AuthoritativeMatchResult {
  return {
    matchId,
    roundId,
    mode: "PAID",
    resultTimestamp: NOW,
    players: [
      { playerId: "player-1", finalRank: 1, finalMass: 500, foodCollected: 30, eliminations: 2, deaths: 0, survivalTimeMs: 600_000 },
      { playerId: "player-2", finalRank: 2, finalMass: 300, foodCollected: 20, eliminations: 1, deaths: 1, survivalTimeMs: 590_000 },
      { playerId: "player-3", finalRank: 3, finalMass: 180, foodCollected: 10, eliminations: 0, deaths: 2, survivalTimeMs: 570_000 },
      { playerId: "player-4", finalRank: 4, finalMass: 100, foodCollected: 5, eliminations: 0, deaths: 2, survivalTimeMs: 540_000 },
      { playerId: "player-5", finalRank: 5, finalMass: 90, foodCollected: 4, eliminations: 0, deaths: 2, survivalTimeMs: 520_000 },
      { playerId: "player-6", finalRank: 6, finalMass: 80, foodCollected: 3, eliminations: 0, deaths: 2, survivalTimeMs: 500_000 },
    ]
  };
}

interface TestState {
  match: Record<string, unknown> & { status: string };
  entries: Array<{ id: string; playerId: string; status: string; amountBaseUnits: bigint; wallet: { address: string } }>;
  result?: { id: string; matchId: string; roundId: string; rulesHash: string; resultHash: string; resultPayload: unknown };
  attempt?: { resultId: string; resultHash: string; settlementId: string; idempotencyKey: string };
  payouts: Array<{ resultId: string; entryId: string; kind: string; place: number | null; grossAmountBaseUnits: bigint; deliveryFeeBaseUnits: bigint; amountBaseUnits: bigint; idempotencyKey: string }>;
  auditEvents: unknown[];
  serializationFailures: number;
  transactionCalls: number;
  isolationLevels: unknown[];
}

function createState(terms: PaidMatchTerms): TestState {
  const configuration = terms.configuration;
  const revive = terms.reviveConfiguration;
  return {
    match: {
      id: terms.matchId,
      roundId: terms.roundId,
      status: "LIVE",
      ruleset: terms.ruleset,
      rulesVersion: terms.rulesVersion,
      rulesHash: terms.rulesHash,
      settlementAsset: terms.settlementAsset,
      usdcMint: terms.usdcMint,
      entryAmountBaseUnits: configuration.entryAmountBaseUnits,
      reviveAmountBaseUnits: revive.reviveAmountBaseUnits,
      maxRevivesPerPlayer: revive.maxRevivesPerPlayer,
      reviveWindowMs: revive.reviveWindowMs,
      reviveCutoffMs: revive.reviveCutoffMs,
      reviveSpawnProtectionMs: revive.spawnProtectionMs,
      platformFeeBps: Number(configuration.platformFeeBps),
      payoutDeliveryFeeBps: Number(configuration.payoutDeliveryFeeBps),
      participationRebateBps: Number(configuration.participationRebateBps),
      payoutBps: configuration.prizeDistribution.map((payout) => Number(payout.basisPoints)),
      minimumPlayers: configuration.minimumPlayers,
      maximumPlayers: configuration.maximumPlayers,
      roundDurationMs: configuration.roundDurationMs,
      fundingDeadline: terms.fundingDeadline,
      startsAt: new Date(NOW.getTime() - configuration.roundDurationMs),
      escrowAddress: terms.escrowAddress,
    },
    entries: participants().map((participant, index) => ({
      id: "entry-" + (index + 1),
      playerId: participant.playerId,
      status: "VERIFIED",
      amountBaseUnits: configuration.entryAmountBaseUnits,
      wallet: { address: participant.walletAddress },
    })),
    payouts: [],
    auditEvents: [],
    serializationFailures: 0,
    transactionCalls: 0,
    isolationLevels: [],
  };
}

function createPrisma(state: TestState): PrismaClient {
  const transaction = {
    match: {
      findUnique: async () => state.match,
      update: async ({ data }: { data: { status: string; endsAt: Date } }) => {
        state.match.status = data.status;
        state.match.endsAt = data.endsAt;
        return state.match;
      }
    },
    matchResult: {
      findUnique: async () => state.result ?? null,
      create: async ({ data }: { data: Omit<NonNullable<TestState["result"]>, "id"> & { finalizedAt: Date } }) => {
        state.result = { id: "result-1", ...data };
        return { id: state.result.id };
      }
    },
    matchEntry: {
      findMany: async ({ where }: { where: { status: { in: string[] } } }) => state.entries
        .filter((entry) => where.status.in.includes(entry.status))
    },
    settlementAttempt: {
      findUnique: async () => state.attempt ?? null,
      create: async ({ data }: { data: NonNullable<TestState["attempt"]> & { matchId: string } }) => {
        state.attempt = data;
        return data;
      }
    },
    payout: {
      createMany: async ({ data }: { data: Array<{ resultId: string; entryId: string; kind: string; place: number | null; grossAmountBaseUnits: bigint; deliveryFeeBaseUnits: bigint; amountBaseUnits: bigint; idempotencyKey: string }> }) => {
        state.payouts.push(...data);
        return { count: data.length };
      },
      findMany: async () => state.payouts,
    },
    auditEvent: {
      create: async ({ data }: { data: unknown }) => {
        state.auditEvents.push(data);
        return data;
      }
    }
  };
  return {
    $transaction: async <T>(
      callback: (client: typeof transaction) => Promise<T>,
      options?: { isolationLevel?: unknown },
    ) => {
      state.transactionCalls += 1;
      state.isolationLevels.push(options?.isolationLevel);
      if (state.serializationFailures > 0) {
        state.serializationFailures -= 1;
        throw { code: "P2034" };
      }
      return callback(transaction);
    }
  } as unknown as PrismaClient;
}
