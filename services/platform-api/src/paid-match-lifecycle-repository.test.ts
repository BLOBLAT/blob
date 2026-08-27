import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import {
  PaidMatchLifecycleError,
  PrismaPaidMatchLifecycleRepository,
} from "./paid-match-lifecycle-repository.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("paid-match lifecycle orchestration", () => {
  it("moves a complete roster through the server-only lifecycle and fixes the live start time", async () => {
    const state = createState();
    const repository = new PrismaPaidMatchLifecycleRepository(createPrisma(state));

    await repository.transition({ matchId: "match-1", to: "OPEN", now: NOW });
    await repository.transition({ matchId: "match-1", to: "FUNDING", now: NOW });
    state.entries.forEach((entry) => { entry.status = "VERIFIED"; });
    await repository.transition({ matchId: "match-1", to: "READY", now: NOW });
    await repository.transition({ matchId: "match-1", to: "STARTING", now: NOW });
    state.entries.forEach((entry) => { entry.status = "CONSUMED"; });

    await expect(repository.transition({ matchId: "match-1", to: "LIVE", now: NOW }))
      .resolves.toEqual({ matchId: "match-1", from: "STARTING", to: "LIVE", startsAt: NOW });
    expect(state.match).toMatchObject({ status: "LIVE", startsAt: NOW });
    expect(state.auditEvents).toHaveLength(5);
    expect(state.isolationLevels).toEqual(Array(5).fill(Prisma.TransactionIsolationLevel.Serializable));
  });

  it("rejects a partial roster, an expired funding window, and any live refund path", async () => {
    const state = createState();
    const repository = new PrismaPaidMatchLifecycleRepository(createPrisma(state));
    state.match.status = "FUNDING";
    state.entries[0]!.status = "VERIFIED";

    await expect(repository.transition({ matchId: "match-1", to: "READY", now: NOW }))
      .rejects.toMatchObject({ code: "VERIFIED_ROSTER_INVALID" } satisfies Partial<PaidMatchLifecycleError>);

    state.entries.forEach((entry) => { entry.status = "VERIFIED"; });
    state.match.fundingDeadline = new Date(NOW.getTime());
    await expect(repository.transition({ matchId: "match-1", to: "READY", now: NOW }))
      .rejects.toMatchObject({ code: "FUNDING_DEADLINE_EXPIRED" } satisfies Partial<PaidMatchLifecycleError>);

    state.match.status = "LIVE";
    await expect(repository.transition({ matchId: "match-1", to: "REFUNDING", now: NOW }))
      .rejects.toMatchObject({ code: "LIFECYCLE_TRANSITION_INVALID" } satisfies Partial<PaidMatchLifecycleError>);
  });

  it("requires every funded entry to consume admission before LIVE", async () => {
    const state = createState();
    state.match.status = "STARTING";
    state.entries.forEach((entry) => { entry.status = "CONSUMED"; });
    state.entries[2]!.status = "VERIFIED";
    const repository = new PrismaPaidMatchLifecycleRepository(createPrisma(state));

    await expect(repository.transition({ matchId: "match-1", to: "LIVE", now: NOW }))
      .rejects.toMatchObject({ code: "CONSUMED_ROSTER_INVALID" } satisfies Partial<PaidMatchLifecycleError>);
    expect(state.match.startsAt).toBeNull();
  });

  it("retries one serializable write conflict", async () => {
    const state = createState();
    state.serializationFailures = 1;
    const repository = new PrismaPaidMatchLifecycleRepository(createPrisma(state));

    await expect(repository.transition({ matchId: "match-1", to: "OPEN", now: NOW }))
      .resolves.toMatchObject({ from: "DRAFT", to: "OPEN" });
    expect(state.transactionCalls).toBe(2);
  });
});

interface TestState {
  match: { id: string; status: string; minimumPlayers: number; maximumPlayers: number; fundingDeadline: Date; startsAt: Date | null };
  entries: Array<{ status: string }>;
  auditEvents: unknown[];
  isolationLevels: unknown[];
  serializationFailures: number;
  transactionCalls: number;
}

function createState(): TestState {
  return {
    match: {
      id: "match-1",
      status: "DRAFT",
      minimumPlayers: 3,
      maximumPlayers: 3,
      fundingDeadline: new Date(NOW.getTime() + 60_000),
      startsAt: null,
    },
    entries: [{ status: "RESERVED" }, { status: "RESERVED" }, { status: "RESERVED" }],
    auditEvents: [],
    isolationLevels: [],
    serializationFailures: 0,
    transactionCalls: 0,
  };
}

function createPrisma(state: TestState): PrismaClient {
  const transaction = {
    match: {
      findUnique: async () => ({ ...state.match }),
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: { status: string; startsAt?: Date } }) => {
        if (where.id !== state.match.id || where.status !== state.match.status) return { count: 0 };
        state.match.status = data.status;
        if (data.startsAt) state.match.startsAt = data.startsAt;
        return { count: 1 };
      }
    },
    matchEntry: {
      findMany: async () => state.entries.map((entry) => ({ ...entry })),
    },
    auditEvent: {
      create: async ({ data }: { data: unknown }) => {
        state.auditEvents.push(data);
        return data;
      }
    }
  };
  return {
    $transaction: async <T>(callback: (client: typeof transaction) => Promise<T>, options?: { isolationLevel?: unknown }) => {
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
