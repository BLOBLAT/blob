import { Client } from "@colyseus/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARENA_ROOM_NAME } from "./BlobArenaRoom.js";
import { createGameServer, type GameServerHandle } from "./server.js";

let server: GameServerHandle;
let endpoint: string;

beforeAll(async () => {
  server = createGameServer(undefined, {
    arenaConfig: {
      countdownDurationMs: 20,
      matchDurationMs: 5_000,
      finishedDurationMs: 20,
      resultsDurationMs: 30,
      spawnProtectionMs: 1,
      inputTimeoutMs: 120,
    },
  });
  const port = await server.listen(0);
  endpoint = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.shutdown();
});

describe("BLOB arena room", () => {
  it("serves a health check with the configured local CORS origin", async () => {
    const response = await fetch(`${endpoint}/health`, {
      headers: { Origin: "http://127.0.0.1:5173" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    await expect(response.json()).resolves.toEqual({ service: "blob-game-server", status: "ok" });
  });

  it("reports privacy-minimal live visitors and rejects malformed presence", async () => {
    const before = await fetch(`${endpoint}/metrics`, {
      headers: { Origin: "http://127.0.0.1:5173" }
    });
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toEqual({ liveVisitors: 0, arenaPlayers: 0 });

    const invalidPresence = await fetch(`${endpoint}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ visitorId: "not-valid" })
    });
    expect(invalidPresence.status).toBe(400);

    const presence = await fetch(`${endpoint}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ visitorId: "abcdefghijklmnopqrstuv" })
    });
    expect(presence.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    await expect(presence.json()).resolves.toEqual({ liveVisitors: 1, arenaPlayers: 0 });
  });

  it("starts a room where two clients receive authoritative state and input-driven movement", async () => {
    const firstClient = new Client(endpoint);
    const secondClient = new Client(endpoint);
    const firstRoom = await firstClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Blob One" });
    const secondRoom = await secondClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Blob Two" });

    await waitUntil(() => getPlayers(firstRoom.state).length === 2 && getPlayers(secondRoom.state).length === 2);
    await waitUntil(async () => (await getLiveMetrics()).arenaPlayers === 2);
    await waitUntil(() => firstRoom.state.phase === "ACTIVE");

    const firstPlayer = firstRoom.state.players.get(firstRoom.sessionId);
    expect(firstPlayer).toBeDefined();
    const originalX = firstPlayer!.x;
    await delay(75);
    firstRoom.send("input", { x: 1, y: 0 });

    await waitUntil(() => {
      const player = firstRoom.state.players.get(firstRoom.sessionId);
      return Boolean(player && player.x > originalX);
    });

    expect(secondRoom.state.players.get(firstRoom.sessionId)?.x).toBeGreaterThan(originalX);
    firstRoom.send("input", { x: 2, y: 0 });
    await delay(350);
    const stoppedAtX = firstRoom.state.players.get(firstRoom.sessionId)?.x;
    await delay(150);
    expect(firstRoom.state.players.get(firstRoom.sessionId)?.x).toBeCloseTo(stoppedAtX ?? originalX, 3);

    await secondRoom.leave();
    await waitUntil(() => getPlayers(firstRoom.state).length === 1);
    await firstRoom.leave();
    await waitUntil(async () => (await getLiveMetrics()).arenaPlayers === 0);
  });
});

function getPlayers(state: { players?: { forEach: (callback: (player: unknown) => void) => void } }): unknown[] {
  const players: unknown[] = [];
  state.players?.forEach((player) => players.push(player));
  return players;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getLiveMetrics(): Promise<{ liveVisitors: number; arenaPlayers: number }> {
  const response = await fetch(`${endpoint}/metrics`);
  return response.json() as Promise<{ liveVisitors: number; arenaPlayers: number }>;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for authoritative room state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
