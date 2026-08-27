import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { PaidEntryReservationError, PrismaPaidEntryReservationRepository } from "./paid-entry-reservation-repository.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("paid entry reservation", () => {
  it("binds one internal user/wallet/player seat and reuses only an exact idempotent retry", async () => {
    const state = createState();
    const repository = new PrismaPaidEntryReservationRepository(createPrisma(state));
    const input = reservationInput();

    await expect(repository.reserve(input)).resolves.toEqual({ created: true, entryId: "entry-1" });
    await expect(repository.reserve(input)).resolves.toEqual({ created: false, entryId: "entry-1" });
    expect(state.entries[0]).toMatchObject({ status: "RESERVED", amountBaseUnits: 1_000_000n });
    await expect(repository.reserve({ ...input, playerId: "player-2" }))
      .rejects.toMatchObject({ code: "ENTRY_IDEMPOTENCY_CONFLICT" } satisfies Partial<PaidEntryReservationError>);
  });

  it("rejects foreign wallets, capacity overflow, and entries after the funding deadline", async () => {
    const state = createState();
    const repository = new PrismaPaidEntryReservationRepository(createPrisma(state));
    await expect(repository.reserve({ ...reservationInput(), walletId: "wallet-other" }))
      .rejects.toMatchObject({ code: "ENTRY_WALLET_MISMATCH" } satisfies Partial<PaidEntryReservationError>);

    state.entries.push({ id: "entry-full", matchId: "match-1", userId: "user-full", walletId: "wallet-full", playerId: "player-full", idempotencyKey: "key-full", status: "RESERVED", amountBaseUnits: 1_000_000n });
    state.match.maximumPlayers = 1;
    await expect(repository.reserve(reservationInput()))
      .rejects.toMatchObject({ code: "MATCH_CAPACITY_REACHED" } satisfies Partial<PaidEntryReservationError>);

    state.entries = [];
    state.match.fundingDeadline = NOW;
    await expect(repository.reserve(reservationInput()))
      .rejects.toMatchObject({ code: "FUNDING_DEADLINE_EXPIRED" } satisfies Partial<PaidEntryReservationError>);
  });
});

function reservationInput() {
  return { matchId: "match-1", userId: "user-1", walletId: "wallet-1", playerId: "player-1", idempotencyKey: "entry-key-1", now: NOW };
}

type Entry = { id: string; matchId: string; userId: string; walletId: string; playerId: string; idempotencyKey: string; status: string; amountBaseUnits: bigint };
function createState() {
  return {
    match: { id: "match-1", status: "FUNDING", maximumPlayers: 3, entryAmountBaseUnits: 1_000_000n, fundingDeadline: new Date(NOW.getTime() + 60_000) },
    wallet: { id: "wallet-1", userId: "user-1" }, entries: [] as Entry[], auditEvents: [] as unknown[],
  };
}
function createPrisma(state: ReturnType<typeof createState>): PrismaClient {
  const tx = {
    matchEntry: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const entry = "idempotencyKey" in where ? state.entries.find((x) => x.idempotencyKey === where.idempotencyKey) : state.entries.find((x) => x.matchId === (where.matchId_userId as { matchId: string }).matchId && x.userId === (where.matchId_userId as { userId: string }).userId);
        return entry ? { ...entry } : null;
      },
      count: async () => state.entries.length,
      create: async ({ data }: { data: Omit<Entry, "id"> }) => { const entry = { id: "entry-" + (state.entries.length + 1), ...data }; state.entries.push(entry); return { id: entry.id }; }
    },
    match: { findUnique: async () => ({ ...state.match }) },
    wallet: { findUnique: async ({ where }: { where: { id: string } }) => where.id === state.wallet.id ? { ...state.wallet } : null },
    auditEvent: { create: async ({ data }: { data: unknown }) => { state.auditEvents.push(data); return data; } }
  };
  return { $transaction: async <T>(callback: (client: typeof tx) => Promise<T>, options?: { isolationLevel?: unknown }) => { expect(options?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable); return callback(tx); } } as unknown as PrismaClient;
}
