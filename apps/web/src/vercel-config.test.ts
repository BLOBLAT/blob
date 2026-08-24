import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatformApiOrigin = process.env.PLATFORM_API_PROXY_ORIGIN;

afterEach(() => {
  if (originalPlatformApiOrigin === undefined) {
    delete process.env.PLATFORM_API_PROXY_ORIGIN;
  } else {
    process.env.PLATFORM_API_PROXY_ORIGIN = originalPlatformApiOrigin;
  }
  vi.resetModules();
});

describe.sequential("Vercel Platform API bridge", () => {
  it("does not add a proxy route without a configured server-only origin", async () => {
    delete process.env.PLATFORM_API_PROXY_ORIGIN;

    const { config } = await import("../vercel.js");

    expect(config.rewrites).toEqual([]);
    expect(config.headers).toEqual([]);
  });

  it("proxies only API paths and disables their caching", async () => {
    process.env.PLATFORM_API_PROXY_ORIGIN = "https://platform.example.test";

    const { config } = await import("../vercel.js");

    expect(config.rewrites).toEqual([{
      source: "/v1/:path*",
      destination: "https://platform.example.test/v1/:path*",
      respectOriginCacheControl: false
    }]);
    expect(config.headers).toEqual([{
      source: "/v1/:path*",
      headers: [{ key: "Cache-Control", value: "private, no-store" }]
    }]);
  });

  it("fails closed for an insecure or path-bearing proxy value", async () => {
    process.env.PLATFORM_API_PROXY_ORIGIN = "http://platform.example.test/v1";

    await expect(import("../vercel.js"))
      .rejects
      .toThrow("PLATFORM_API_PROXY_ORIGIN must be a plain HTTPS origin");
  });
});
