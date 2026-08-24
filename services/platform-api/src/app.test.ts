import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformApp } from "./app.js";
import type { PlatformAuthRepository } from "./auth-types.js";
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
  authRateLimitWindowMs: 60_000,
  gameTicketPrivateKey: undefined,
  gameTicketTtlMs: 60_000,
  paidAdmissionTicketPrivateKey: undefined
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
