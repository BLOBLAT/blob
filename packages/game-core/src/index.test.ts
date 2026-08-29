import { describe, expect, it } from "vitest";
import { ArenaPhase, GameMode } from "@blob/protocol";
import {
  ArenaSimulation,
  calculateFreeModeBotCount,
  calculateFoodTarget,
  calculateWorldSize,
  createArenaConfig,
  radiusFromMass,
} from "./index.js";

const testConfig = {
  width: 240,
  height: 180,
  maxWorldWidth: 960,
  maxWorldHeight: 720,
  countdownDurationMs: 10,
  matchDurationMs: 5_000,
  finishedDurationMs: 5,
  resultsDurationMs: 10,
  foodCount: 1,
  maxFoodCount: 12,
  foodMass: 100,
  baseMoveSpeed: 1_000,
  spawnProtectionMs: 1,
  respawnDelayMs: 40,
  inputTimeoutMs: 80,
  freeModeBotsEnabled: false,
};

function startActive(simulation: ArenaSimulation): number {
  simulation.advance(0);
  simulation.advance(1);
  simulation.advance(11);
  simulation.advance(60);
  expect(simulation.snapshot().phase).toBe(ArenaPhase.ACTIVE);
  return 60;
}

function player(simulation: ArenaSimulation, id: string) {
  const found = simulation.snapshot().players.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error("Expected player " + id);
  }
  return found;
}

function driveToward(simulation: ArenaSimulation, playerId: string, x: number, y: number, now: number): number {
  let cursor = now;
  for (let step = 0; step < 24; step += 1) {
    const current = player(simulation, playerId);
    const distance = Math.hypot(x - current.x, y - current.y);
    if (distance < radiusFromMass(current.mass) + 8) {
      cursor += 50;
      simulation.advance(cursor);
      break;
    }
    cursor += 50;
    if (!simulation.setInput(playerId, {
      x: (x - current.x) / distance,
      y: (y - current.y) / distance,
    }, cursor)) {
      break;
    }
    simulation.advance(cursor);
  }
  return cursor;
}

describe("authoritative round lifecycle", () => {
  it("waits for the minimum population and transitions through every server phase", () => {
    const simulation = new ArenaSimulation({
      ...testConfig,
      minPlayersToStart: 2,
      matchDurationMs: 100,
    });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.advance(0);
    expect(simulation.snapshot().phase).toBe(ArenaPhase.MATCHMAKING);

    simulation.addPlayer("two", "Blob Two", 1);
    simulation.advance(1);
    const countdown = simulation.snapshot();
    expect(countdown.phase).toBe(ArenaPhase.COUNTDOWN);
    expect(countdown.matchId).not.toBe("");
    expect(countdown.roundId).not.toBe("");

    simulation.advance(11);
    expect(simulation.snapshot().phase).toBe(ArenaPhase.ACTIVE);
    simulation.advance(111);
    expect(simulation.snapshot().phase).toBe(ArenaPhase.FINISHED);
    expect(simulation.snapshot().result?.rankings).toHaveLength(2);
    simulation.advance(116);
    expect(simulation.snapshot().phase).toBe(ArenaPhase.RESULTS);
    simulation.advance(126);
    expect(simulation.snapshot().phase).toBe(ArenaPhase.WAITING);
  });

  it("sizes a bounded world and food target deterministically from player population", () => {
    const config = createArenaConfig({
      ...testConfig,
      minPlayersToStart: 2,
      maxPlayers: 32,
    });
    expect(calculateWorldSize(2, config)).toEqual({ width: 240, height: 180 });
    expect(calculateWorldSize(8, config)).toEqual({ width: 480, height: 360 });
    expect(calculateWorldSize(32, config)).toEqual({ width: 960, height: 720 });
    expect(calculateFoodTarget(2, config)).toBe(1);
    expect(calculateFoodTarget(10, config)).toBe(5);
  });

  it("accepts only valid authoritative movement intent and stops after stale input", () => {
    const simulation = new ArenaSimulation({ ...testConfig, foodMass: 1 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    let now = startActive(simulation);
    const initial = player(simulation, "one").x;

    expect(simulation.setInput("one", { x: Number.NaN, y: 0 }, now)).toBe(false);
    expect(simulation.setInput("one", { x: 2, y: 0 }, now)).toBe(false);
    now += 50;
    expect(simulation.setInput("one", { x: 1, y: 0 }, now)).toBe(true);
    simulation.advance(now);
    const moving = player(simulation, "one").x;
    expect(moving).toBeGreaterThan(initial);

    simulation.advance(now + 200);
    expect(player(simulation, "one").x).toBe(moving);
  });

  it("applies an explicit stop without waiting for the movement rate limit", () => {
    const simulation = new ArenaSimulation({ ...testConfig, foodMass: 1, inputTimeoutMs: 1_000 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    const now = startActive(simulation) + 50;

    expect(simulation.setInput("one", { x: 1, y: 0 }, now)).toBe(true);
    simulation.advance(now);
    const moving = player(simulation, "one").x;

    expect(simulation.setInput("one", { x: 0, y: 0 }, now + 1)).toBe(true);
    simulation.advance(now + 51);
    expect(player(simulation, "one").x).toBe(moving);
  });

  it("reports authoritative input rejection reasons without trusting a malformed movement vector", () => {
    const simulation = new ArenaSimulation({ ...testConfig, foodMass: 1 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    const now = startActive(simulation) + 50;

    expect(simulation.trySetInput("one", { x: 2, y: 0 }, now)).toEqual({
      accepted: false,
      reason: "INVALID_VECTOR",
    });
    expect(simulation.trySetInput("unknown", { x: 1, y: 0 }, now)).toEqual({
      accepted: false,
      reason: "PLAYER_NOT_FOUND",
    });
    expect(simulation.trySetInput("one", { x: 1, y: 0 }, Number.NaN)).toEqual({
      accepted: false,
      reason: "INVALID_TIMESTAMP",
    });
  });

  it("admits a Free Mode player into an active round with a safe protected spawn", () => {
    const simulation = new ArenaSimulation({ ...testConfig, foodMass: 1 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    const now = startActive(simulation);

    simulation.addPlayer("late", "Late Blob", now);
    const latePlayer = player(simulation, "late");

    expect(simulation.snapshot().phase).toBe(ArenaPhase.ACTIVE);
    expect(latePlayer).toMatchObject({
      alive: true,
      inRound: true,
      mass: simulation.config.startingMass,
      foodCollected: 0,
      kills: 0,
    });
    expect(latePlayer.spawnProtectedUntil).toBeGreaterThan(now);
    expect(latePlayer.x).toBeGreaterThanOrEqual(radiusFromMass(latePlayer.mass));
    expect(latePlayer.y).toBeGreaterThanOrEqual(radiusFromMass(latePlayer.mass));
    expect(simulation.setInput("late", { x: 1, y: 0 }, now + 50)).toBe(true);
  });

  it("keeps server-calculated movement within world bounds", () => {
    const simulation = new ArenaSimulation({ ...testConfig, foodMass: 1 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    let now = startActive(simulation);
    for (let step = 0; step < 20; step += 1) {
      now += 50;
      simulation.setInput("one", { x: 1, y: -1 }, now);
      simulation.advance(now);
    }
    const view = simulation.snapshot();
    const mover = player(simulation, "one");
    const radius = radiusFromMass(mover.mass);
    expect(mover.x).toBeLessThanOrEqual(view.world.width - radius);
    expect(mover.y).toBeGreaterThanOrEqual(radius);
  });

  it("slides a player along a world boundary instead of sticking on a diagonal input", () => {
    const simulation = new ArenaSimulation({ ...testConfig, foodMass: 1 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    let now = startActive(simulation);
    for (let step = 0; step < 10; step += 1) {
      now += 50;
      expect(simulation.setInput("one", { x: -1, y: 0 }, now)).toBe(true);
      simulation.advance(now);
    }
    const againstLeftWall = player(simulation, "one");
    const radius = radiusFromMass(againstLeftWall.mass);
    expect(againstLeftWall.x).toBe(radius);

    now += 50;
    expect(simulation.setInput("one", { x: -1, y: 1 }, now)).toBe(true);
    simulation.advance(now);
    const afterDiagonalMove = player(simulation, "one");

    expect(afterDiagonalMove.x).toBe(radius);
    expect(afterDiagonalMove.y).toBeGreaterThan(againstLeftWall.y);
  });

  it("tracks personal food, validates an eat, records death, and respawns", () => {
    const simulation = new ArenaSimulation({ ...testConfig, respawnDelayMs: 200 });
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    let now = startActive(simulation);

    const pellet = simulation.snapshot().food[0];
    if (!pellet) {
      throw new Error("Expected server food");
    }
    now = driveToward(simulation, "one", pellet.x, pellet.y, now);
    expect(player(simulation, "one").foodCollected).toBeGreaterThan(0);
    expect(player(simulation, "one").mass).toBeGreaterThan(simulation.config.startingMass);

    const target = player(simulation, "two");
    now = driveToward(simulation, "one", target.x, target.y, now);
    for (let step = 0; step < 10 && player(simulation, "two").alive; step += 1) {
      const nextTarget = player(simulation, "two");
      now = driveToward(simulation, "one", nextTarget.x, nextTarget.y, now);
      now += 50;
      simulation.advance(now);
    }
    expect(player(simulation, "one").kills).toBe(1);
    expect(player(simulation, "two").alive).toBe(false);
    expect(player(simulation, "two").deaths).toBe(1);

    simulation.advance(now + simulation.config.respawnDelayMs + 1);
    expect(player(simulation, "two").alive).toBe(true);
    expect(player(simulation, "two").mass).toBe(simulation.config.startingMass);
  });

  it("uses survival time and then join sequence as deterministic round tie breakers", () => {
    const simulation = new ArenaSimulation({
      ...testConfig,
      foodMass: 1,
      matchDurationMs: 100,
    });
    simulation.addPlayer("alpha", "Alpha", 0);
    simulation.addPlayer("beta", "Beta", 0);
    startActive(simulation);
    simulation.advance(160);

    const result = simulation.snapshot().result;
    expect(result?.rankings.map((entry) => entry.playerId)).toEqual(["alpha", "beta"]);
  });

  it("removes disconnected players from matchmaking and never starts an empty round", () => {
    const simulation = new ArenaSimulation(testConfig);
    simulation.addPlayer("one", "Blob One", 0);
    simulation.advance(0);
    simulation.removePlayer("one");
    simulation.advance(1);

    expect(simulation.snapshot()).toMatchObject({
      phase: ArenaPhase.WAITING,
      matchmakingPlayerCount: 0,
      players: [],
    });
  });
});

describe("disclosed Free Mode arena bots", () => {
  it("adds a varied server-controlled roster for one human and starts a playable Free round", () => {
    const simulation = new ArenaSimulation({
      ...testConfig,
      freeModeBotsEnabled: true,
      freeModeBotMinCount: 3,
      freeModeBotMaxCount: 5,
    });
    simulation.addPlayer("human", "Human", 0);
    simulation.advance(0);

    const matchmaking = simulation.snapshot();
    expect(matchmaking.phase).toBe(ArenaPhase.MATCHMAKING);
    expect(matchmaking.humanPlayerCount).toBe(1);
    expect(matchmaking.botPlayerCount).toBeGreaterThanOrEqual(3);
    expect(matchmaking.botPlayerCount).toBeLessThanOrEqual(5);
    expect(matchmaking.matchmakingPlayerCount).toBe(matchmaking.humanPlayerCount + matchmaking.botPlayerCount);
    expect(matchmaking.players.filter((participant) => participant.isBot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: expect.stringMatching(/^ARENA /), isBot: true })]),
    );

    let now = startActive(simulation);
    const before = simulation.snapshot().players
      .filter((participant) => participant.isBot)
      .map((participant) => ({ id: participant.id, x: participant.x, y: participant.y }));
    now += simulation.config.botDecisionIntervalMs + 50;
    simulation.advance(now);
    const after = simulation.snapshot();
    expect(after.players.some((participant) => {
      const previous = before.find((candidate) => candidate.id === participant.id);
      return Boolean(previous && participant.isBot && (participant.x !== previous.x || participant.y !== previous.y));
    })).toBe(true);
    expect(after.leaderboard.every((entry) => typeof entry.isBot === "boolean")).toBe(true);
  });

  it("keeps bots out of Paid Mode and always makes space for a real player", () => {
    const paid = new ArenaSimulation({
      ...testConfig,
      mode: GameMode.PAID,
      freeModeBotsEnabled: true,
      paidRoundIdentity: { matchId: "paid-match-1", roundId: "paid-round-1" },
    });
    paid.addPlayer("paid-human", "Paid Human", 0);
    paid.advance(0);
    expect(paid.snapshot()).toMatchObject({
      phase: ArenaPhase.MATCHMAKING,
      humanPlayerCount: 1,
      botPlayerCount: 0,
      matchmakingPlayerCount: 1,
    });

    const free = new ArenaSimulation({
      ...testConfig,
      maxPlayers: 4,
      freeModeBotsEnabled: true,
      freeModeBotMinCount: 3,
      freeModeBotMaxCount: 3,
    });
    free.addPlayer("first-human", "First Human", 0);
    free.advance(0);
    expect(free.snapshot()).toMatchObject({ humanPlayerCount: 1, botPlayerCount: 3 });
    free.addPlayer("second-human", "Second Human", 1);
    expect(free.snapshot()).toMatchObject({ humanPlayerCount: 2, botPlayerCount: 2 });
  });

  it("requires immutable server-assigned IDs for Paid Mode and never restarts a finalized paid round", () => {
    expect(() => new ArenaSimulation({ ...testConfig, mode: GameMode.PAID })).toThrow(
      "Paid Mode requires distinct server-assigned matchId and roundId values.",
    );
    expect(() => new ArenaSimulation({
      ...testConfig,
      paidRoundIdentity: { matchId: "free-match", roundId: "free-round" },
    })).toThrow("paidRoundIdentity is only valid for Paid Mode.");

    const paid = new ArenaSimulation({
      ...testConfig,
      mode: GameMode.PAID,
      minPlayersToStart: 2,
      matchDurationMs: 100,
      paidRoundIdentity: { matchId: "paid-match-immutable", roundId: "paid-round-immutable" },
    });
    paid.addPlayer("one", "Blob One", 0);
    paid.addPlayer("two", "Blob Two", 0);
    paid.advance(0);
    paid.advance(1);
    const countdown = paid.snapshot();
    expect(countdown).toMatchObject({
      phase: ArenaPhase.COUNTDOWN,
      matchId: "paid-match-immutable",
      roundId: "paid-round-immutable",
      botPlayerCount: 0,
    });
    paid.advance(11);
    paid.advance(111);
    paid.advance(116);
    paid.advance(126);
    expect(paid.snapshot().phase).toBe(ArenaPhase.WAITING);
    paid.advance(127);
    expect(paid.snapshot()).toMatchObject({
      phase: ArenaPhase.WAITING,
      matchId: "",
      roundId: "",
    });
  });

  it("uses a bounded reproducible 3–5 participant selection and removes bots after results", () => {
    const config = createArenaConfig({ ...testConfig, freeModeBotsEnabled: true, freeModeBotMinCount: 3, freeModeBotMaxCount: 5 });
    const rosterCounts = [1, 2, 3, 4, 5, 6].map((matchNumber) => calculateFreeModeBotCount(matchNumber, config));
    expect(rosterCounts.every((count) => count >= 3 && count <= 5)).toBe(true);
    expect(new Set(rosterCounts).size).toBeGreaterThan(1);

    const simulation = new ArenaSimulation({
      ...testConfig,
      freeModeBotsEnabled: true,
      freeModeBotMinCount: 3,
      freeModeBotMaxCount: 3,
      matchDurationMs: 100,
    });
    simulation.addPlayer("human", "Human", 0);
    startActive(simulation);
    simulation.advance(160);
    expect(simulation.snapshot().result?.rankings.some((entry) => entry.isBot)).toBe(true);
    simulation.advance(166);
    simulation.advance(176);
    expect(simulation.snapshot()).toMatchObject({
      phase: ArenaPhase.WAITING,
      humanPlayerCount: 1,
      botPlayerCount: 0,
      matchmakingPlayerCount: 1,
    });
  });
});
