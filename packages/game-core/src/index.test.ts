import { describe, expect, it } from "vitest";
import { ArenaPhase } from "@blob/protocol";
import {
  ArenaSimulation,
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
