import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePlatformApiProxyOrigin } from "./platformProxyConfig.js";

const vercelConfig = JSON.parse(readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8")) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  rewrites: Array<{ source: string; destination: string }>;
};

describe.sequential("Vercel Platform API bridge", () => {
  it("uses a real Vercel config for the narrow same-site bridge", () => {
    expect(vercelConfig.rewrites).toEqual([{
      source: "/v1/(.*)",
      destination: "/api/platform?__blob_proxy_path=$1"
    }]);
    expect(vercelConfig.headers).toEqual([
      {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
      ]
      },
      {
        source: "/v1/(.*)",
        headers: [{ key: "Cache-Control", value: "private, no-store" }]
      }
    ]);
  });

  it("keeps the upstream host server-only and accepts only a plain HTTPS origin", () => {
    expect(resolvePlatformApiProxyOrigin(undefined)).toBeUndefined();
    expect(resolvePlatformApiProxyOrigin("https://platform.example.test")).toBe("https://platform.example.test");
    expect(resolvePlatformApiProxyOrigin("http://platform.example.test")).toBeUndefined();
    expect(resolvePlatformApiProxyOrigin("https://user:pass@platform.example.test")).toBeUndefined();
    expect(resolvePlatformApiProxyOrigin("https://platform.example.test/v1")).toBeUndefined();
  });
});
