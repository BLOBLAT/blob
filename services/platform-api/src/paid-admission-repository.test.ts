import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import {
  PaidAdmissionPersistenceError,
  PrismaPaidAdmissionRepository,
} from "./paid-admission-repository.js";

const NOW = new Date("2026-08-24T13:00:00.000Z");
const PRIVATE_KEY = new Uint8Array(32).fill(7);

describe("durable paid admission tickets", () => {
  it("issues only a hashed ticket for an exact verified entry, then consumes it once", async () => {
    const state = createState();
    const repository = new PrismaPaidAdmissionRepository(createPrisma(state));
    const issued = await repository.issue({ entryId: "entry-1", privateKey: PRIVATE_KEY, now: NOW, ttlMs: 10_000 });

    expect(issued.claims).toMatchObject({ entryId: "entry-1", matchId: "match-1", roundId: "round-1", playerId: "player-1" });
    expect(state.entry.admissionTokenHash).not.toBe(issued.token);
    expect(state.entry.admissionExpiresAt).toEqual(new Date(NOW.getTime() + 10_000));
    state.match.status = "STARTING";

    await expect(repository.consume({ token: issued.token, claims: issued.claims, now: NOW })).resolves.toBeUndefined();
    expect(state.entry.status).toBe("CONSUMED");
    expect(state.auditEvents.map((event) => (event as { action: string }).action)).toEqual([
      "paid_admission_issued",
      "paid_admission_consumed",
    ]);
    await expect(repository.consume({ token: issued.token, claims: issued.claims, now: NOW }))
      .rejects.toMatchObject({ code: "ADMISSION_NOT_CONSUMABLE" } satisfies Partial<PaidAdmissionPersistenceError>);
  });

  it("does not issue a second live ticket and can replace only an expired one", async () => {
    const state = createState();
    const repository = new PrismaPaidAdmissionRepository(createPrisma(state));
    await repository.issue({ entryId: "entry-1", privateKey: PRIVATE_KEY, now: NOW, ttlMs: 10_000 });
    await expect(repository.issue({ entryId: "entry-1", privateKey: PRIVATE_KEY, now: NOW, ttlMs: 10_000 }))
      .rejects.toMatchObject({ code: "ADMISSION_ALREADY_ISSUED" } satisfies Partial<PaidAdmissionPersistenceError>);

    await expect(repository.issue({ entryId: "entry-1", privateKey: PRIVATE_KEY, now: new Date(NOW.getTime() + 10_001), ttlMs: 10_000 }))
      .resolves.toHaveProperty("token");
  });

  it("fails closed for a ticket from the wrong lifecycle or a mismatched claim", async () => {
    const state = createState();
    const repository = new PrismaPaidAdmissionRepository(createPrisma(state));
    const issued = await repository.issue({ entryId: "entry-1", privateKey: PRIVATE_KEY, now: NOW, ttlMs: 10_000 });
    state.match.status = "LIVE";
    await expect(repository.consume({ token: issued.token, claims: issued.claims, now: NOW }))
      .rejects.toMatchObject({ code: "ADMISSION_NOT_CONSUMABLE" } satisfies Partial<PaidAdmissionPersistenceError>);

    state.match.status = "STARTING";
    await expect(repository.consume({ token: issued.token, claims: { ...issued.claims, playerId: "player-2" }, now: NOW }))
      .rejects.toMatchObject({ code: "ADMISSION_NOT_CONSUMABLE" } satisfies Partial<PaidAdmissionPersistenceError>);
  });
});

interface TestState {
  match: { roundId: string; rulesHash: string; status: string };
  entry: {
    id: string;
    userId: string;
    matchId: string;
    playerId: string;
    status: string;
    admissionTokenHash: string | null;
    admissionIssuedAt: Date | null;
    admissionExpiresAt: Date | null;
  };
  auditEvents: unknown[];
}

function createState(): TestState {
  return {
    match: { roundId: "round-1", rulesHash: "a".repeat(64), status: "READY" },
    entry: {
      id: "entry-1",
      userId: "user-1",
      matchId: "match-1",
      playerId: "player-1",
      status: "VERIFIED",
      admissionTokenHash: null,
      admissionIssuedAt: null,
      admissionExpiresAt: null,
    },
    auditEvents: [],
  };
}

function createPrisma(state: TestState): PrismaClient {
  const transaction = {
    matchEntry: {
      findUnique: async () => ({ ...state.entry, match: state.match }),
      updateMany: async ({ where, data }: { where: { id: string; status: string; admissionTokenHash: string | null }; data: Record<string, unknown> }) => {
        if (where.id !== state.entry.id || where.status !== state.entry.status || where.admissionTokenHash !== state.entry.admissionTokenHash) {
          return { count: 0 };
        }
        if ("status" in data) state.entry.status = data.status as string;
        if ("admissionTokenHash" in data) state.entry.admissionTokenHash = data.admissionTokenHash as string | null;
        if ("admissionIssuedAt" in data) state.entry.admissionIssuedAt = data.admissionIssuedAt as Date;
        if ("admissionExpiresAt" in data) state.entry.admissionExpiresAt = data.admissionExpiresAt as Date;
        return { count: 1 };
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
    $transaction: async <T>(callback: (client: typeof transaction) => Promise<T>, options?: { isolationLevel?: unknown }) => {
      expect(options?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable);
      return callback(transaction);
    }
  } as unknown as PrismaClient;
}
