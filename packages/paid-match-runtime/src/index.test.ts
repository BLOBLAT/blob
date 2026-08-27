import { describe, expect, it } from "vitest";
import type { PaidAdmissionClaims, PaidAdmissionConsumer } from "@blob/paid-admission-client";
import { ArenaPhase } from "@blob/protocol";
import { PaidArenaRuntime, PaidArenaTransportAdapter } from "./index.js";

const claims: Record<string, PaidAdmissionClaims> = ["one", "two", "three"].reduce((all, token, index) => ({
  ...all,
  [token]: { audience: "blob-game-server", entryId: "entry-" + (index + 1), matchId: "match-1", roundId: "round-1", playerId: "player-" + (index + 1), rulesHash: "a".repeat(64), issuedAt: 0, expiresAt: 60_000, nonce: "00000000-0000-4000-8000-00000000000" + (index + 1) }
}), {} as Record<string, PaidAdmissionClaims>);

describe("paid arena runtime", () => {
  it("admits only consumed signed tickets and produces a wallet-free immutable result", async () => {
    const runtime = new PaidArenaRuntime({
      matchId: "match-1", roundId: "round-1", admissionConsumer: new FakeConsumer(),
      arenaConfig: { minPlayersToStart: 3, maxPlayers: 3, countdownDurationMs: 10, finishedDurationMs: 5, resultsDurationMs: 10, freeModeBotsEnabled: true }
    });
    await runtime.admit({ sessionId: "session-1", token: "one" });
    await runtime.admit({ sessionId: "session-2", token: "two" });
    await runtime.admit({ sessionId: "session-3", token: "three" });
    runtime.advance(0); runtime.advance(1);
    expect(runtime.snapshot()).toMatchObject({ phase: ArenaPhase.COUNTDOWN, matchId: "match-1", roundId: "round-1", botPlayerCount: 0 });
    runtime.advance(11); runtime.advance(600_011);
    const result = runtime.finalizedResult();
    expect(result).toMatchObject({ mode: "PAID", matchId: "match-1", roundId: "round-1" });
    expect(result?.players).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("wallet");
  });

  it("rejects duplicate transport sessions and duplicate paid players", async () => {
    const runtime = new PaidArenaRuntime({ matchId: "match-1", roundId: "round-1", admissionConsumer: new FakeConsumer() });
    await runtime.admit({ sessionId: "session-1", token: "one" });
    await expect(runtime.admit({ sessionId: "session-1", token: "two" })).rejects.toMatchObject({ code: "PAID_ADMISSION_UNAVAILABLE" });
    await expect(runtime.admit({ sessionId: "session-2", token: "one" })).rejects.toMatchObject({ code: "PAID_ADMISSION_DUPLICATE" });
  });

  it("rejects Free-like paid configuration", () => {
    expect(() => new PaidArenaRuntime({
      matchId: "match-1", roundId: "round-1", admissionConsumer: new FakeConsumer(),
      arenaConfig: { minPlayersToStart: 2 }
    })).toThrow("Paid arena configuration does not match immutable paid rules.");
  });

  it("never consumes an admission after the paid roster is frozen for countdown", async () => {
    const runtime = new PaidArenaRuntime({
      matchId: "match-1", roundId: "round-1", admissionConsumer: new FakeConsumer(),
      arenaConfig: { minPlayersToStart: 3, maxPlayers: 3, countdownDurationMs: 10 }
    });
    await runtime.admit({ sessionId: "session-1", token: "one" });
    await runtime.admit({ sessionId: "session-2", token: "two" });
    await runtime.admit({ sessionId: "session-3", token: "three" });
    runtime.advance(0); runtime.advance(1);
    await expect(runtime.admit({ sessionId: "session-4", token: "one" }))
      .rejects.toMatchObject({ code: "PAID_ADMISSION_UNAVAILABLE" });
  });

  it("publishes one immutable wallet-free result only after the authoritative round ends", async () => {
    const published: unknown[] = [];
    const adapter = new PaidArenaTransportAdapter(new PaidArenaRuntime({
      matchId: "match-1", roundId: "round-1", admissionConsumer: new FakeConsumer(),
      arenaConfig: { minPlayersToStart: 3, maxPlayers: 3, countdownDurationMs: 10, finishedDurationMs: 5 }
    }), { publish: async (result) => { published.push(result); } });
    await adapter.join("session-1", "one"); await adapter.join("session-2", "two"); await adapter.join("session-3", "three");
    await adapter.tick(0); await adapter.tick(1); await adapter.tick(11);
    expect(published).toHaveLength(0);
    await adapter.tick(600_011); await adapter.tick(600_012);
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published[0])).not.toContain("wallet");
  });
});

class FakeConsumer implements PaidAdmissionConsumer {
  async consume(input: { token: string; expectedMatchId: string; expectedRoundId: string }): Promise<PaidAdmissionClaims> {
    const claim = claims[input.token];
    if (!claim || claim.matchId !== input.expectedMatchId || claim.roundId !== input.expectedRoundId) throw new Error("invalid ticket");
    return claim;
  }
}
