import { createServer } from "node:http";
import * as ed25519 from "@noble/ed25519";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformApp } from "./app.js";
import { DisplayNameConflictError, type PlatformAuthRepository } from "./auth-types.js";
import type { PlatformApiConfig } from "./config.js";

const config: PlatformApiConfig = {
  databaseUrl: "postgresql://blob:blob@127.0.0.1:5432/blob?schema=public",
  port: 3000,
  nodeEnv: "test",
  publicOrigin: "http://127.0.0.1:5173",
  allowedWebOrigins: new Set(["http://127.0.0.1:5173"]),
  sessionCookieName: "blob_session",
  sessionTtlMs: 60_000,
  challengeTtlMs: 60_000,
  renameCooldownMs: 60_000,
  authChallengeRateLimit: 2,
  authVerifyRateLimit: 2,
  authGlobalRateLimit: 3,
  authRateLimitWindowMs: 60_000,
  globalRateLimitWindowMs: 60_000,
  gameTicketPrivateKey: undefined,
  gameTicketTtlMs: 60_000,
  gameTicketRateLimit: 2,
  gameTicketGlobalRateLimit: 3,
  paidAdmissionTicketPrivateKey: undefined,
  paidAdmissionConsumerPublicKey: undefined,
  arenaChatAuditPublicKey: undefined,
  arenaChatRetentionDays: 90
};

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("platform API health", () => {
  it("reports healthy only after the supplied durable-store probe succeeds", async () => {
    const check = vi.fn(async () => undefined);
    const response = await requestHealth(check);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "blob-platform-api", status: "ok" });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent health requests so a flood cannot multiply database probes", async () => {
    const check = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const app = createPlatformApp({
      config,
      repository: {} as PlatformAuthRepository,
      healthCheck: check
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const url = "http://127.0.0.1:" + address.port + "/health";
    const responses = await Promise.all([fetch(url), fetch(url), fetch(url)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(responses[0]?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports unavailable without exposing a database error", async () => {
    const response = await requestHealth(async () => {
      throw new Error("database credentials must not be returned to callers");
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ service: "blob-platform-api", status: "unavailable" });
  });

  it("limits repeated wallet challenge creation", async () => {
    const app = createPlatformApp({
      config,
      repository: { createChallenge: async () => undefined } as unknown as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const url = "http://127.0.0.1:" + address.port + "/v1/auth/challenge";
    const request = () => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: "11111111111111111111111111111111" })
    });
    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(201);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("limits aggregate challenge creation across different wallet addresses", async () => {
    const app = createPlatformApp({
      config,
      repository: { createChallenge: async () => undefined } as unknown as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const url = "http://127.0.0.1:" + address.port + "/v1/auth/challenge";
    const request = (walletAddress: string) => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress })
    });

    const wallets = [
      "1".repeat(32),
      "1".repeat(31) + "2",
      "1".repeat(31) + "3",
      "1".repeat(31) + "4"
    ];
    expect((await request(wallets[0]!)).status).toBe(201);
    expect((await request(wallets[1]!)).status).toBe(201);
    expect((await request(wallets[2]!)).status).toBe(201);
    const limited = await request(wallets[3]!);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("limits signed arena profile tickets per authenticated player", async () => {
    const ticketConfig: PlatformApiConfig = {
      ...config,
      gameTicketPrivateKey: new Uint8Array(32).fill(7)
    };
    const app = createPlatformApp({
      config: ticketConfig,
      repository: {
        findActiveSession: async () => ({
          id: "session-1",
          tokenHash: "hash",
          user: {
            userId: "user-1",
            displayName: "BLOB-ONE",
            walletAddress: "11111111111111111111111111111111",
            renamedAt: null
          },
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null
        })
      } as unknown as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const url = "http://127.0.0.1:" + address.port + "/v1/me/game-ticket";
    const request = () => fetch(url, { headers: { Cookie: "blob_session=" + "x".repeat(43) } });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("requires a legacy reserved profile name to be changed before issuing an arena ticket", async () => {
    const ticketConfig: PlatformApiConfig = {
      ...config,
      gameTicketPrivateKey: new Uint8Array(32).fill(9)
    };
    const app = createPlatformApp({
      config: ticketConfig,
      repository: {
        findActiveSession: async () => ({
          id: "session-1",
          tokenHash: "hash",
          user: {
            userId: "user-1",
            displayName: "BLOB-admin",
            walletAddress: "11111111111111111111111111111111",
            renamedAt: null
          },
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null
        })
      } as unknown as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }

    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/me/game-ticket", {
      headers: { Cookie: "blob_session=" + "x".repeat(43) }
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PROFILE_NAME_CHANGE_REQUIRED",
      message: "Choose a compliant display name before entering the arena."
    });
  });

  it("limits signed arena profile tickets across authenticated players", async () => {
    const ticketConfig: PlatformApiConfig = {
      ...config,
      gameTicketPrivateKey: new Uint8Array(32).fill(8),
      gameTicketRateLimit: 4,
      gameTicketGlobalRateLimit: 2
    };
    let sessionLookup = 0;
    const app = createPlatformApp({
      config: ticketConfig,
      repository: {
        findActiveSession: async () => {
          sessionLookup += 1;
          return {
            id: "session-" + sessionLookup,
            tokenHash: "hash-" + sessionLookup,
            user: {
              userId: "user-" + sessionLookup,
              displayName: "BLOB-" + sessionLookup,
              walletAddress: "11111111111111111111111111111111",
              renamedAt: null
            },
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null
          };
        }
      } as unknown as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const url = "http://127.0.0.1:" + address.port + "/v1/me/game-ticket";
    const request = () => fetch(url, { headers: { Cookie: "blob_session=" + "x".repeat(43) } });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  });

  it("rejects a browser origin outside the explicit allowlist without a server error", async () => {
    const app = createPlatformApp({
      config,
      repository: { createChallenge: async () => undefined } as unknown as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }

    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/auth/challenge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example"
      },
      body: JSON.stringify({ walletAddress: "11111111111111111111111111111111" })
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "ORIGIN_NOT_ALLOWED",
      message: "This browser origin is not allowed to access the platform API."
    });
  });

  it("rejects oversized public JSON without returning an internal error", async () => {
    const app = createPlatformApp({
      config,
      repository: {} as PlatformAuthRepository,
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }

    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(17 * 1024) })
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "REQUEST_TOO_LARGE",
      message: "Request data is too large."
    });
  });

  it("returns a deliberate conflict when another profile owns a display name", async () => {
    const repository = {
      findActiveSession: async () => ({
        id: "session-1",
        tokenHash: "hash",
        user: {
          userId: "user-1",
          displayName: "BLOB-EXAMPLE",
          walletAddress: "11111111111111111111111111111111",
          renamedAt: null
        },
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null
      }),
      renameUser: async () => {
        throw new DisplayNameConflictError("Display name is already in use.");
      }
    } as unknown as PlatformAuthRepository;
    const app = createPlatformApp({ config, repository, healthCheck: async () => undefined });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }

    const response = await fetch("http://127.0.0.1:" + address.port + "/v1/me/profile", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: "blob_session=" + "x".repeat(43)
      },
      body: JSON.stringify({ displayName: "Claimed Name" })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PROFILE_NAME_UNAVAILABLE",
      message: "That display name is already in use."
    });
  });

  it("records only a correctly signed game-server chat audit message", async () => {
    const privateKey = new Uint8Array(32).fill(4);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const store = vi.fn(async () => undefined);
    const app = createPlatformApp({
      config: { ...config, arenaChatAuditPublicKey: publicKey },
      repository: {} as PlatformAuthRepository,
      arenaChatRepository: { store, pruneExpired: async () => 0 },
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start test HTTP server.");
    }
    const record = {
      id: "7f9f4c4d-53d1-4cc6-9f8a-90548bef7654",
      roomId: "room-1",
      matchId: "match-1",
      roundId: "round-1",
      profileUserId: null,
      anonymousAuthorKey: "a".repeat(43),
      authorName: "Blob Prime",
      text: "nice move",
      sentAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000
    };
    const body = Buffer.from(JSON.stringify(record));
    const signature = await ed25519.signAsync(body, privateKey);
    const url = "http://127.0.0.1:" + address.port + "/internal/arena-chat/messages";

    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BLOB-Arena-Audit-Signature": Buffer.from(signature).toString("base64")
      },
      body
    });
    expect(accepted.status).toBe(201);
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ id: record.id, text: "nice move" }));

    const rejected = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    expect(rejected.status).toBe(401);
  });

  it("accepts a signed private paid-admission consume request only once configured", async () => {
    const privateKey = new Uint8Array(32).fill(6);
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const consume = vi.fn(async () => undefined);
    const app = createPlatformApp({
      config: { ...config, paidAdmissionConsumerPublicKey: publicKey },
      repository: {} as PlatformAuthRepository,
      paidAdmissionRepository: { consume },
      healthCheck: async () => undefined
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start test HTTP server.");
    const payload = {
      token: "ticket-value",
      claims: {
        audience: "blob-game-server",
        entryId: "entry-1",
        matchId: "match-1",
        roundId: "round-1",
        playerId: "player-1",
        rulesHash: "a".repeat(64),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        nonce: "7f9f4c4d-53d1-4cc6-9f8a-90548bef7654"
      }
    };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = await ed25519.signAsync(body, privateKey);
    const url = "http://127.0.0.1:" + address.port + "/internal/paid-admissions/consume";
    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BLOB-Paid-Admission-Signature": Buffer.from(signature).toString("base64")
      },
      body
    });
    expect(accepted.status).toBe(204);
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({ token: "ticket-value", claims: expect.objectContaining({ entryId: "entry-1" }) }));

    const rejected = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(rejected.status).toBe(401);
  });
});

async function requestHealth(healthCheck: () => Promise<void>): Promise<Response> {
  const app = createPlatformApp({
    config,
    repository: {} as PlatformAuthRepository,
    healthCheck
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start test HTTP server.");
  }
  return fetch("http://127.0.0.1:" + address.port + "/health");
}
