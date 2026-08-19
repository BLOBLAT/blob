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
  renameCooldownMs: 60_000
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
