import { describe, expect, it } from "vitest";
import { loadPlatformApiConfig } from "./config.js";

const DATABASE_URL = "postgresql://blob:blob@127.0.0.1:5432/blob?schema=public";

describe("platform API production configuration", () => {
  it("requires HTTPS for every browser origin in production", () => {
    expect(() => loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat,http://localhost:5173"
    })).toThrow("PLATFORM_WEB_ORIGIN must contain only HTTPS origins");
  });

  it("rejects malformed numeric configuration instead of truncating it", () => {
    expect(() => loadPlatformApiConfig({
      DATABASE_URL,
      PLATFORM_SESSION_TTL_MS: "60000oops"
    })).toThrow("PLATFORM_SESSION_TTL_MS must be a positive integer");

    expect(loadPlatformApiConfig({ DATABASE_URL, PORT: "3000oops" }).port).toBe(3000);
  });

  it("accepts the production BLOB origin allowlist", () => {
    const config = loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat,https://www.blob.lat",
      PORT: "3001"
    });
    expect(config.port).toBe(3001);
    expect([...config.allowedWebOrigins]).toEqual(["https://blob.lat", "https://www.blob.lat"]);
    expect(config.sessionCookieName).toBe("__Host-blob_session");
  });

  it("requires a host-only cookie name in production", () => {
    expect(() => loadPlatformApiConfig({
      NODE_ENV: "production",
      DATABASE_URL,
      PLATFORM_PUBLIC_ORIGIN: "https://blob.lat",
      PLATFORM_WEB_ORIGIN: "https://blob.lat",
      PLATFORM_SESSION_COOKIE_NAME: "blob_session"
    })).toThrow("PLATFORM_SESSION_COOKIE_NAME must use the __Host- prefix");
  });
});
