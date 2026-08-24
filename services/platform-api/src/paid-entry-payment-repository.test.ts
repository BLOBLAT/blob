import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import {
  PaidEntryPaymentPersistenceError,
  PrismaPaidEntryPaymentRepository,
} from "./paid-entry-payment-repository.js";

const NOW = new Date("2026-08-24T10:00:00.000Z");
const FINALIZED_AT = new Date("2026-08-24T10:01:00.000Z");
const DEADLINE = new Date("2026-08-24T10:05:00.000Z");
const WALLET = "4Nd1m3sW3vJ3zN9WZ1xQ2u5d7i9K6p4YvTq8eR1sA2bC";
const SIGNATURE = "3vQB7B6MrGQZaxCuFg4oh".padEnd(88, "1");

describe("durable paid entry payment receipt", () => {
  it("records one verified receipt and atomically admits its exact reserved entry", async () => {
    const state = createState();
    const repository = new PrismaPaidEntryPaymentRepository(createPrisma(state));

    await expect(repository.persist(input())).resolves.toEqual({ created: true, entryId: "entry-1", transactionId: "tx-1" });
    expect(state.entry).toMatchObject({ status: "VERIFIED", transactionId: "tx-1", fundedAt: FINALIZED_AT });
    expect(state.transactions).toEqual([expect.objectContaining({
      id: "tx-1",
      matchId: "match-1",
      kind: "ENTRY",
      signature: SIGNATURE,
      amountBaseUnits: 1_000_000n,
      finalizedAt: FINALIZED_AT,
      idempotencyKey: "entry-payment:entry-1",
    })]);
    expect(state.auditEvents).toEqual([expect.objectContaining({
      action: "paid_entry_verified",
      metadata: { slot: 123 },
    })]);
    expect(JSON.stringify(state.auditEvents)).not.toContain(WALLET);
  });

  it("returns the same durable receipt for an identical retry", async () => {
    const state = createState();
    const repository = new PrismaPaidEntryPaymentRepository(createPrisma(state));
    const first = await repository.persist(input());

    await expect(repository.persist(input())).resolves.toEqual({ ...first, created: false });
    expect(state.transactions).toHaveLength(1);
    expect(state.auditEvents).toHaveLength(1);
  });

  it("rejects an attempted reuse of a finalized signature", async () => {
    const state = createState();
    state.transactions.push({
      id: "tx-other",
      matchId: "match-2",
      kind: "ENTRY",
      signature: SIGNATURE,
      amountBaseUnits: 1_000_000n,
      walletAddress: WALLET,
      finalizedAt: FINALIZED_AT,
      idempotencyKey: "entry-payment:entry-other",
    });
    const repository = new PrismaPaidEntryPaymentRepository(createPrisma(state));

    await expect(repository.persist(input())).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_CONFLICT" } satisfies Partial<PaidEntryPaymentPersistenceError>);
    expect(state.entry.status).toBe("RESERVED");
  });

  it("requires exact entry identity, funding lifecycle, and a pre-deadline chain timestamp", async () => {
    const wrongIdentity = new PrismaPaidEntryPaymentRepository(createPrisma(createState()));
    await expect(wrongIdentity.persist({ ...input(), userId: "user-2" }))
      .rejects.toMatchObject({ code: "ENTRY_IDENTITY_MISMATCH" } satisfies Partial<PaidEntryPaymentPersistenceError>);

    const notFunding = createState();
    notFunding.match.status = "READY";
    await expect(new PrismaPaidEntryPaymentRepository(createPrisma(notFunding)).persist(input()))
      .rejects.toMatchObject({ code: "MATCH_NOT_FUNDING" } satisfies Partial<PaidEntryPaymentPersistenceError>);

    const late = createState();
    await expect(new PrismaPaidEntryPaymentRepository(createPrisma(late)).persist({
      ...input(), payment: { ...input().payment, finalizedAt: DEADLINE }
    })).rejects.toMatchObject({ code: "PAYMENT_AFTER_FUNDING_DEADLINE" } satisfies Partial<PaidEntryPaymentPersistenceError>);
  });

  it("retries one serializable-write conflict without duplicating the payment", async () => {
    const state = createState();
    state.serializationFailures = 1;
    const repository = new PrismaPaidEntryPaymentRepository(createPrisma(state));

    await expect(repository.persist(input())).resolves.toMatchObject({ created: true });
    expect(state.transactionCalls).toBe(2);
    expect(state.isolationLevels).toEqual([
      Prisma.TransactionIsolationLevel.Serializable,
      Prisma.TransactionIsolationLevel.Serializable,
    ]);
    expect(state.transactions).toHaveLength(1);
  });
});

function input() {
  return {
    entryId: "entry-1",
    userId: "user-1",
    walletId: "wallet-1",
    walletAddress: WALLET,
    payment: { signature: SIGNATURE, slot: 123, finalizedAt: FINALIZED_AT },
  };
}

interface TestTransaction {
  id: string;
  matchId: string;
  kind: string;
  signature: string;
  amountBaseUnits: bigint;
  walletAddress: string;
  finalizedAt: Date | null;
  idempotencyKey: string;
}

interface TestState {
  match: { status: string; fundingDeadline: Date };
  entry: {
    id: string;
    matchId: string;
    userId: string;
    walletId: string;
    status: string;
    amountBaseUnits: bigint;
    transactionId: string | null;
    fundedAt: Date | null;
    wallet: { address: string };
  };
  transactions: TestTransaction[];
  auditEvents: unknown[];
  serializationFailures: number;
  transactionCalls: number;
  isolationLevels: unknown[];
}

function createState(): TestState {
  return {
    match: { status: "FUNDING", fundingDeadline: DEADLINE },
    entry: {
      id: "entry-1",
      matchId: "match-1",
      userId: "user-1",
      walletId: "wallet-1",
      status: "RESERVED",
      amountBaseUnits: 1_000_000n,
      transactionId: null,
      fundedAt: null,
      wallet: { address: WALLET },
    },
    transactions: [],
    auditEvents: [],
    serializationFailures: 0,
    transactionCalls: 0,
    isolationLevels: [],
  };
}

function createPrisma(state: TestState): PrismaClient {
  const transaction = {
    matchEntry: {
      findUnique: async () => ({ ...state.entry, match: state.match }),
      updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] }; transactionId: null }; data: { status: string; transactionId: string; fundedAt: Date } }) => {
        if (where.id !== state.entry.id || !where.status.in.includes(state.entry.status) || state.entry.transactionId !== null) {
          return { count: 0 };
        }
        state.entry.status = data.status;
        state.entry.transactionId = data.transactionId;
        state.entry.fundedAt = data.fundedAt;
        return { count: 1 };
      }
    },
    chainTransaction: {
      findUnique: async ({ where }: { where: { id?: string; signature?: string } }) => state.transactions.find((record) =>
        (where.id !== undefined && record.id === where.id) || (where.signature !== undefined && record.signature === where.signature)
      ) ?? null,
      create: async ({ data }: { data: Omit<TestTransaction, "id" | "confirmedAt"> & { confirmedAt: Date } }) => {
        const record: TestTransaction = { id: "tx-" + (state.transactions.length + 1), ...data };
        state.transactions.push(record);
        return { id: record.id };
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
