/**
 * This value is read only by the Vercel server-side proxy. It must never be a
 * VITE_ variable or reach browser code; the browser calls its own /v1 path.
 */
export function resolvePlatformApiProxyOrigin(value = process.env.PLATFORM_API_PROXY_ORIGIN): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
