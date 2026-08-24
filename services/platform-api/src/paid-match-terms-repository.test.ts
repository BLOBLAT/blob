import { describe, expect, it } from "vitest";
import { PaidRuleset } from "@blob/shared";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { createPaidMatchTerms, type PaidMatchTerms } from "./paid-match.js";
import {
  PaidMatchTermsPersistenceError,
  PrismaPaidMatchTermsRepository,
} from "./paid-match-terms-repository.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ESCROW = "9xQeWvG816bUx9EPfEZgC3Jk6zR9aM2Qq8F4JZ2xAazC";

describe("durable immutable paid-match terms", () => {
  it("persists controlled terms as DRAFT before any entry can be funded", async () => {
    const terms = createTerms();
    const state = createState();
    const repository = new PrismaPaidMatchTermsRepository(createPrisma(state));

    await expect(repository.persist(terms)).resolves.toEqual({ created: true, matchId: terms.matchId, roundId: terms.roundId });
    expect(state.match).toMatchObject({
      id: terms.matchId,
      roundId: terms.roundId,
      status: "DRAFT",
      rulesHash: terms.rulesHash,
      fundingDeadline: terms.fundingDeadline,
    });
    expect(state.auditEvents).toEqual([expect.objectContaining({
      action: "paid_match_terms_created",
      metadata: { roundId: terms.roundId, rulesHash: terms.rulesHash },
    })]);
  });

  it("reuses an exact terms record and rejects an immutable-term mismatch", async () => {
    const terms = createTerms();
    const state = createState();
    const repository = new PrismaPaidMatchTermsRepository(createPrisma(state));
    await repository.persist(terms);

    await expect(repository.persist(terms)).resolves.toEqual({ created: false, matchId: terms.matchId, roundId: terms.roundId });
    const divergent = { ...terms, rulesHash: "f".repeat(64) };
    await expect(repository.persist(divergent))
      .rejects.toMatchObject({ code: "MATCH_TERMS_CONFLICT" } satisfies Partial<PaidMatchTermsPersistenceError>);
    expect(state.auditEvents).toHaveLength(1);
  });

  it("retries a concurrent serializable write once", async () => {
    const terms = createTerms();
    const state = createState();
    state.serializationFailures = 1;
    const repository = new PrismaPaidMatchTermsRepository(createPrisma(state));

    await expect(repository.persist(terms)).resolves.toMatchObject({ created: true });
    expect(state.transactionCalls).toBe(2);
    expect(state.isolationLevels).toEqual([
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable,
    ]);
  });
});

function createTerms(): PaidMatchTerms {
  return createPaidMatchTerms({
    usdcMint: USDC_MINT,
    escrowAddress: ESCROW,
    ruleset: PaidRuleset.SKILL,
    now: NOW,
  });
}

interface TestState {
  match: Record<string, unknown> | null;
  auditEvents: unknown[];
  serializationFailures: number;
  transactionCalls: number;
  isolationLevels: unknown[];
}

function createState(): TestState {
  return { match: null, auditEvents: [], serializationFailures: 0, transactionCalls: 0, isolationLevels: [] };
}

function createPrisma(state: TestState): PrismaClient {
  const transaction = {
    match: {
      findUnique: async () => state.match,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.match = data;
        return data;
      }
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
