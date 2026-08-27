import { ArenaSimulation, type ArenaConfig } from "@blob/game-core";
import { ArenaPhase, GameMode, type MovementIntent } from "@blob/protocol";
import type { PaidAdmissionConsumer } from "@blob/paid-admission-client";
import { PAID_MATCH_MAX_PLAYERS, PAID_MATCH_ROUND_DURATION_MS, PAID_MATCH_WINNER_COUNT, type AuthoritativeMatchResult } from "@blob/shared";
import { createHash } from "node:crypto";

export interface PaidArenaRuntimeOptions {
  matchId: string;
  roundId: string;
  admissionConsumer: PaidAdmissionConsumer;
  arenaConfig?: Partial<ArenaConfig>;
}

/**
 * Server-only foundation for a future isolated Paid Room. It accepts only a
 * consumed platform admission, maps untrusted transport sessions to the
 * ticket's internal player ID, and emits a wallet-free authoritative result.
 */
export class PaidArenaRuntime {
  private readonly simulation: ArenaSimulation;
  private readonly sessionPlayers = new Map<string, string>();

  constructor(private readonly options: PaidArenaRuntimeOptions) {
    assertIdentifier(options.matchId, "matchId");
    assertIdentifier(options.roundId, "roundId");
    if (options.matchId === options.roundId) throw new PaidArenaRuntimeError("PAID_RUNTIME_CONFIG_INVALID", "Paid round identifiers must differ.");
    this.simulation = new ArenaSimulation({
      ...options.arenaConfig,
      mode: GameMode.PAID,
      minPlayersToStart: options.arenaConfig?.minPlayersToStart ?? PAID_MATCH_WINNER_COUNT,
      maxPlayers: options.arenaConfig?.maxPlayers ?? PAID_MATCH_MAX_PLAYERS,
      matchDurationMs: options.arenaConfig?.matchDurationMs ?? PAID_MATCH_ROUND_DURATION_MS,
      respawnEnabled: false,
      freeModeBotsEnabled: false,
      // Bot counts remain positive configuration values, but are ignored by
      // Paid Mode because freeModeBotsEnabled is false and mode is PAID.
      freeModeBotMinCount: 1,
      freeModeBotMaxCount: 1,
      paidRoundIdentity: { matchId: options.matchId, roundId: options.roundId },
    });
    if (this.simulation.config.minPlayersToStart < PAID_MATCH_WINNER_COUNT
      || this.simulation.config.maxPlayers > PAID_MATCH_MAX_PLAYERS
      || this.simulation.config.matchDurationMs !== PAID_MATCH_ROUND_DURATION_MS) {
      throw new PaidArenaRuntimeError("PAID_RUNTIME_CONFIG_INVALID", "Paid arena configuration does not match immutable paid rules.");
    }
  }

  async admit(input: { sessionId: string; token: string }): Promise<{ playerId: string }> {
    assertIdentifier(input.sessionId, "sessionId");
    const phase = this.simulation.snapshot().phase;
    if (this.sessionPlayers.has(input.sessionId) || (phase !== ArenaPhase.WAITING && phase !== ArenaPhase.MATCHMAKING)) {
      throw new PaidArenaRuntimeError("PAID_ADMISSION_UNAVAILABLE", "Paid admission is not available for this session.");
    }
    const claims = await this.options.admissionConsumer.consume({
      token: input.token,
      expectedMatchId: this.options.matchId,
      expectedRoundId: this.options.roundId,
    });
    if ([...this.sessionPlayers.values()].includes(claims.playerId)) {
      throw new PaidArenaRuntimeError("PAID_ADMISSION_DUPLICATE", "Paid entry is already connected.");
    }
    this.simulation.addPlayer(claims.playerId, anonymizedName(claims.playerId), Date.now());
    if (!this.simulation.snapshot().players.some((player) => player.id === claims.playerId)) {
      throw new PaidArenaRuntimeError("PAID_ADMISSION_CAPACITY", "Paid match has no available seat.");
    }
    this.sessionPlayers.set(input.sessionId, claims.playerId);
    return { playerId: claims.playerId };
  }

  setInput(sessionId: string, input: MovementIntent, now: number): boolean {
    const playerId = this.sessionPlayers.get(sessionId);
    return Boolean(playerId && this.simulation.setInput(playerId, input, now));
  }

  advance(now: number): void { this.simulation.advance(now); }

  snapshot() { return this.simulation.snapshot(); }

  finalizedResult(): AuthoritativeMatchResult | null {
    const result = this.simulation.snapshot().result;
    if (!result || result.mode !== GameMode.PAID) return null;
    return {
      matchId: result.matchId,
      roundId: result.roundId,
      mode: "PAID",
      resultTimestamp: new Date(result.finalizedAt),
      players: result.rankings.map((player) => ({
        playerId: player.playerId,
        finalRank: player.rank,
        finalMass: player.finalMass,
        foodCollected: player.foodCollected,
        eliminations: player.eliminations,
        deaths: player.deaths,
        survivalTimeMs: player.survivalTimeMs,
      }))
    };
  }
}

export interface PaidMatchResultSink {
  publish(result: AuthoritativeMatchResult): Promise<void>;
}

/**
 * Transport-facing adapter for an isolated Paid Room. A future Colyseus room
 * supplies session IDs and snapshots, while this class keeps all admission,
 * input mapping, and exactly-once successful result publication server-side.
 */
export class PaidArenaTransportAdapter {
  private publishedResultKey: string | undefined;

  constructor(private readonly runtime: PaidArenaRuntime, private readonly resultSink: PaidMatchResultSink) {}

  async join(sessionId: string, admissionToken: string): Promise<{ playerId: string }> {
    return this.runtime.admit({ sessionId, token: admissionToken });
  }

  input(sessionId: string, intent: MovementIntent, now: number): boolean {
    return this.runtime.setInput(sessionId, intent, now);
  }

  async tick(now: number) {
    this.runtime.advance(now);
    const result = this.runtime.finalizedResult();
    if (!result) return this.runtime.snapshot();
    const key = result.matchId + ":" + result.roundId;
    if (this.publishedResultKey !== key) {
      await this.resultSink.publish(result);
      this.publishedResultKey = key;
    }
    return this.runtime.snapshot();
  }
}

export class PaidArenaRuntimeError extends Error { constructor(readonly code: string, message: string) { super(message); } }

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new PaidArenaRuntimeError("PAID_RUNTIME_CONFIG_INVALID", label + " is invalid.");
}
function anonymizedName(playerId: string): string { return "BLOB-" + createHash("sha256").update(playerId).digest("hex").slice(0, 8).toUpperCase(); }
