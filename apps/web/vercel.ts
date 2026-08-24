import { routes, type VercelConfig } from "@vercel/config/v1";

const platformApiOrigin = readPlatformApiOrigin(
  process.env.PLATFORM_API_PROXY_ORIGIN
);
const platformApiRewrite = platformApiOrigin
  ? {
      ...routes.rewrite("/v1/:path*", `${platformApiOrigin}/v1/:path*`),
      respectOriginCacheControl: false
    }
  : undefined;

/**
 * Wallet-profile requests are proxied only when Vercel has been given the
 * server-only origin. The browser still calls its own HTTPS origin, keeping
 * opaque session cookies same-site while api.blob.lat is provisioned.
 */
export const config: VercelConfig = {
  headers: platformApiOrigin
    ? [
        routes.header("/v1/:path*", [
          { key: "Cache-Control", value: "private, no-store" }
        ])
      ]
    : [],
  rewrites: platformApiRewrite ? [platformApiRewrite] : []
};

function readPlatformApiOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const candidate = value.trim();
  const url = new URL(candidate);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PLATFORM_API_PROXY_ORIGIN must be a plain HTTPS origin without credentials or a path."
    );
  }

  return url.origin;
}
