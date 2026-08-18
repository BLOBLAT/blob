import { describe, expect, it } from "vitest";
import { ArenaSimulation, ArenaPhase, canPlayerEat } from "./index.js";

describe("arena lifecycle", () => {
  it("moves through countdown, playing, results, and restart using server time", () => {
    const simulation = new ArenaSimulation({
      countdownMs: 100,
      matchDurationMs: 200,
      resultsDurationMs: 100,
      foodCount: 0,
      spawnProtectionMs: 0
    }, 0);
    simulation.addPlayer("one", "Blob One", 0);

    simulation.advance(0);
    expect(simulation.snapshot(0).phase).toBe(ArenaPhase.COUNTDOWN);
    simulation.advance(100);
    expect(simulation.snapshot(100).phase).toBe(ArenaPhase.PLAYING);
    simulation.advance(300);
    expect(simulation.snapshot(300).phase).toBe(ArenaPhase.RESULTS);
    simulation.advance(400);
    expect(simulation.snapshot(400).phase).toBe(ArenaPhase.LOBBY);
  });
});

describe("authoritative simulation rules", () => {
  it("uses input as intent and calculates movement only at the server tick", () => {
    const simulation = new ArenaSimulation({ countdownMs: 0, foodCount: 0, spawnProtectionMs: 0 }, 0);
    simulation.addPlayer("one", "Blob One", 0);
    simulation.advance(0);
    simulation.advance(1);
    const initialX = simulation.snapshot(1).players[0]?.x ?? 0;

    expect(simulation.setInput("one", { x: 1, y: 0 }, 100)).toBe(true);
    simulation.advance(150);

    expect(simulation.snapshot(150).players[0]?.x).toBeGreaterThan(initialX);
  });

  it("requires a server-verified mass advantage before one player can eat another", () => {
    const eater = { alive: true, mass: 130, x: 100, y: 100, spawnProtectedUntil: 0 };
    const victim = { alive: true, mass: 100, x: 102, y: 100, spawnProtectedUntil: 0 };

    expect(canPlayerEat(eater, victim, 1, { minMassRatioToEat: 1.25 })).toBe(true);
    expect(canPlayerEat({ ...eater, mass: 120 }, victim, 1, { minMassRatioToEat: 1.25 })).toBe(false);
  });

  it("grows from server food, resolves a death, and respawns the victim", () => {
    const simulation = new ArenaSimulation({
      width: 100,
      height: 100,
      countdownMs: 0,
      foodCount: 1,
      foodMass: 100,
      spawnProtectionMs: 50,
      respawnMs: 100,
      matchDurationMs: 60_000
    }, 0);
    simulation.addPlayer("one", "Blob One", 0);
    simulation.addPlayer("two", "Blob Two", 0);
    simulation.advance(0);
    simulation.advance(1);

    simulation.setInput("one", { x: -1, y: -1 }, 100);
    simulation.advance(150);
    simulation.advance(200);

    const afterCollision = simulation.snapshot(200);
    const victim = afterCollision.players.find((player) => player.id === "two");
    const winner = afterCollision.players.find((player) => player.id === "one");
    expect(winner?.kills).toBe(1);
    expect(winner?.mass).toBeGreaterThan(100);
    expect(victim?.alive).toBe(false);
    expect(victim?.deaths).toBe(1);

    simulation.advance(300);
    const respawned = simulation.snapshot(300).players.find((player) => player.id === "two");
    expect(respawned?.alive).toBe(true);
    expect(respawned?.mass).toBe(100);
  });
});
