import { Client } from "@colyseus/sdk";
import { Encoder } from "@colyseus/schema";
import type { ArenaChatAuditRecord } from "@blob/validation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARENA_ROOM_NAME } from "./BlobArenaRoom.js";
import { ARENA_STATE_ENCODER_BUFFER_BYTES, createGameServer, resolveAllowedOrigins, resolveWebSocketSourceAddress, type GameServerHandle } from "./server.js";
import { PresenceRateLimiter, WebSocketUpgradeRateLimiter } from "./liveMetrics.js";
import { ClientMessage, ServerEvent, type ArenaChatMessage } from "@blob/protocol";

let server: GameServerHandle;
let endpoint: string;
const chatAuditRecords: ArenaChatAuditRecord[] = [];

beforeAll(async () => {
  server = createGameServer(undefined, {
    arenaConfig: {
      countdownDurationMs: 20,
      matchDurationMs: 5_000,
      finishedDurationMs: 20,
      resultsDurationMs: 30,
      spawnProtectionMs: 1,
      inputTimeoutMs: 120,
      freeModeBotsEnabled: true,
      freeModeBotMinCount: 3,
      freeModeBotMaxCount: 3,
    },
    chatPersistence: {
      enabled: true,
      persist: async (record) => {
        chatAuditRecords.push(record);
        return true;
      }
    }
  });
  const port = await server.listen(0);
  endpoint = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.shutdown();
});

describe("BLOB arena room", () => {
  it("allocates enough encoder capacity for a full authoritative Free Mode snapshot", () => {
    expect(Encoder.BUFFER_SIZE).toBeGreaterThanOrEqual(ARENA_STATE_ENCODER_BUFFER_BYTES);
  });

  it("serves a health check with the configured local CORS origin", async () => {
    const response = await fetch(`${endpoint}/health`, {
      headers: { Origin: "http://127.0.0.1:5173" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    await expect(response.json()).resolves.toEqual({ service: "blob-game-server", status: "ok" });

    const directResponse = await fetch(`${endpoint}/health`);
    expect(directResponse.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires explicit production browser origins and normalizes their allowlist", () => {
    expect(() => resolveAllowedOrigins({ NODE_ENV: "production" })).toThrow("BLOB_WEB_ORIGIN is required in production.");
    expect([...resolveAllowedOrigins({
      NODE_ENV: "production",
      BLOB_WEB_ORIGIN: "https://blob.lat/, https://www.blob.lat"
    })]).toEqual(["https://blob.lat", "https://www.blob.lat"]);
  });

  it("reports privacy-minimal live visitors through the origin-protected endpoint", async () => {
    const retiredMetricsEndpoint = await fetch(`${endpoint}/metrics`);
    expect(retiredMetricsEndpoint.status).toBe(404);

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

    const missingOrigin = await fetch(`${endpoint}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: "abcdefghijklmnopqrstuv" })
    });
    expect(missingOrigin.status).toBe(403);
    await expect(missingOrigin.json()).resolves.toEqual({ error: "PRESENCE_ORIGIN_NOT_ALLOWED" });

    const foreignOrigin = await fetch(`${endpoint}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
      body: JSON.stringify({ visitorId: "abcdefghijklmnopqrstuv" })
    });
    expect(foreignOrigin.status).toBe(403);
    await expect(foreignOrigin.json()).resolves.toEqual({ error: "PRESENCE_ORIGIN_NOT_ALLOWED" });
  });

  it("rate limits live-presence updates with an ephemeral non-IP key", () => {
    const limiter = new PresenceRateLimiter(2, 1_000);
    expect(limiter.consume("203.0.113.8", 1_000)).toBe(true);
    expect(limiter.consume("203.0.113.8", 1_001)).toBe(true);
    expect(limiter.consume("203.0.113.8", 1_002)).toBe(false);
    expect(limiter.consume("203.0.113.8", 2_000)).toBe(true);
  });

  it("bounds repeated WebSocket upgrades without retaining source addresses", () => {
    const limiter = new WebSocketUpgradeRateLimiter(2, 1_000);
    expect(limiter.consume("203.0.113.9", 1_000)).toBe(true);
    expect(limiter.consume("203.0.113.9", 1_001)).toBe(true);
    expect(limiter.consume("203.0.113.9", 1_002)).toBe(false);
    expect(limiter.consume("203.0.113.9", 2_000)).toBe(true);
  });

  it("keys a proxied WebSocket upgrade by the forwarded browser address instead of the shared Railway socket", () => {
    expect(resolveWebSocketSourceAddress({
      headers: { "x-forwarded-for": "203.0.113.12, 10.1.0.10" },
      socket: { remoteAddress: "10.1.0.10" },
    } as never)).toBe("203.0.113.12");
    expect(resolveWebSocketSourceAddress({
      headers: { "x-forwarded-for": "not-an-ip" },
      socket: { remoteAddress: "127.0.0.1" },
    } as never)).toBe("127.0.0.1");
  });

  it("starts a room where two clients receive authoritative state and input-driven movement", async () => {
    const firstClient = new Client(endpoint);
    const secondClient = new Client(endpoint);
    const firstRoom = await firstClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Blob One" });
    const secondRoom = await secondClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Blob Two" });

    await waitUntil(() => getPlayers(firstRoom.state).length === 5 && getPlayers(secondRoom.state).length === 5);
    expect(getBotCount(firstRoom.state)).toBe(3);
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
    await waitUntil(() => getPlayers(firstRoom.state).length === 4);
    await firstRoom.leave();
    await waitUntil(async () => (await getLiveMetrics()).arenaPlayers === 0);
  });

  it("disconnects a client that repeatedly submits malformed movement while preserving the arena", async () => {
    const firstClient = new Client(endpoint);
    const secondClient = new Client(endpoint);
    const firstRoom = await firstClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Invalid Input" });
    const secondRoom = await secondClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Valid Observer" });
    await waitUntil(() => firstRoom.state.phase === "ACTIVE");

    let left = false;
    firstRoom.onLeave(() => { left = true; });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      firstRoom.send(ClientMessage.INPUT, { x: 99, y: 0 });
    }

    await waitUntil(() => left);
    await waitUntil(() => getPlayers(secondRoom.state).length === 4);
    expect(secondRoom.state.phase).toBe("ACTIVE");
    await secondRoom.leave();
  });

  it("relays only validated plain chat between real connected arena clients", async () => {
    const firstClient = new Client(endpoint);
    const secondClient = new Client(endpoint);
    const firstRoom = await firstClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Client Name" });
    const secondRoom = await secondClient.joinOrCreate(ARENA_ROOM_NAME, { name: "Other Name" });
    await waitUntil(() => getPlayers(firstRoom.state).length === 5);
    expect(getBotCount(firstRoom.state)).toBe(3);

    const received = nextRoomMessage<ArenaChatMessage>(secondRoom, ServerEvent.CHAT_MESSAGE);
    firstRoom.send(ClientMessage.CHAT_SEND, { text: "  hello\u200B from the pit  " });
    await expect(received).resolves.toMatchObject({
      playerId: firstRoom.sessionId,
      name: firstRoom.state.players.get(firstRoom.sessionId)?.name,
      text: "hello from the pit"
    });
    expect(chatAuditRecords.at(-1)).toMatchObject({
      authorName: firstRoom.state.players.get(firstRoom.sessionId)?.name,
      text: "hello from the pit",
      profileUserId: null,
      anonymousAuthorKey: expect.any(String)
    });
    expect(chatAuditRecords.at(-1)?.anonymousAuthorKey).not.toBe(firstRoom.sessionId);

    const rejected = nextRoomMessage<{ code: string }>(firstRoom, ServerEvent.CHAT_REJECTED);
    firstRoom.send(ClientMessage.CHAT_SEND, { text: "visit https://not-allowed.example" });
    await expect(rejected).resolves.toEqual({ code: "CHAT_LINKS_NOT_ALLOWED" });

    await firstRoom.leave();
    await secondRoom.leave();
  });
});

function getPlayers(state: { players?: { forEach: (callback: (player: unknown) => void) => void } }): unknown[] {
  const players: unknown[] = [];
  state.players?.forEach((player) => players.push(player));
  return players;
}

function getBotCount(state: { players?: { forEach: (callback: (player: unknown) => void) => void } }): number {
  return getPlayers(state).filter((player) => (
    typeof player === "object" && player !== null &&
    "isBot" in player && (player as { isBot?: unknown }).isBot === true
  )).length;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getLiveMetrics(): Promise<{ liveVisitors: number; arenaPlayers: number }> {
  const response = await fetch(`${endpoint}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ visitorId: "server-test-live-metrics" })
  });
  expect(response.status).toBe(200);
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

function nextRoomMessage<T>(room: { onMessage(type: string, callback: (message: T) => void): void }, type: string): Promise<T> {
  return new Promise<T>((resolve) => room.onMessage(type, resolve));
}
