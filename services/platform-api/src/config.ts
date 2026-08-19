export interface PlatformApiConfig {
  databaseUrl: string;
  port: number;
  nodeEnv: "development" | "test" | "production";
  publicOrigin: string;
  allowedWebOrigins: ReadonlySet<string>;
  sessionCookieName: string;
  sessionTtlMs: number;
  challengeTtlMs: number;
  renameCooldownMs: number;
}

const LOCAL_WEB_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

export function loadPlatformApiConfig(environment: NodeJS.ProcessEnv = process.env): PlatformApiConfig {
  const nodeEnv = environment.NODE_ENV === "production"
    ? "production"
    : environment.NODE_ENV === "test"
      ? "test"
      : "development";
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the platform API.");
  }

  const publicOrigin = normalizeOrigin(environment.PLATFORM_PUBLIC_ORIGIN ?? (nodeEnv === "production" ? "" : "http://127.0.0.1:5173"));
  if (!publicOrigin) {
    throw new Error("PLATFORM_PUBLIC_ORIGIN is required in production.");
  }
  if (nodeEnv === "production" && !publicOrigin.startsWith("https://")) {
    throw new Error("PLATFORM_PUBLIC_ORIGIN must use HTTPS in production.");
  }

  const configuredOrigins = environment.PLATFORM_WEB_ORIGIN
    ?.split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
  const allowedWebOrigins = new Set(configuredOrigins?.length ? configuredOrigins : nodeEnv === "production" ? [] : LOCAL_WEB_ORIGINS);
  if (nodeEnv === "production" && allowedWebOrigins.size === 0) {
    throw new Error("PLATFORM_WEB_ORIGIN is required in production.");
  }
  if (nodeEnv === "production" && [...allowedWebOrigins].some((origin) => !origin.startsWith("https://"))) {
    throw new Error("PLATFORM_WEB_ORIGIN must contain only HTTPS origins in production.");
  }

  return {
    databaseUrl,
    port: parsePort(environment.PORT),
    nodeEnv,
    publicOrigin,
    allowedWebOrigins,
    sessionCookieName: environment.PLATFORM_SESSION_COOKIE_NAME ?? "blob_session",
    sessionTtlMs: parsePositiveInteger(environment.PLATFORM_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1_000, "PLATFORM_SESSION_TTL_MS"),
    challengeTtlMs: parsePositiveInteger(environment.PLATFORM_CHALLENGE_TTL_MS, 5 * 60 * 1_000, "PLATFORM_CHALLENGE_TTL_MS"),
    renameCooldownMs: parsePositiveInteger(environment.PLATFORM_RENAME_COOLDOWN_MS, 24 * 60 * 60 * 1_000, "PLATFORM_RENAME_COOLDOWN_MS")
  };
}

function normalizeOrigin(value: string): string {
  const candidate = value.trim().replace(/\/+$/, "");
  if (!candidate) {
    return "";
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function parsePort(value: string | undefined): number {
  const port = parseInteger(value ?? "3000");
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 3000;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(name + " must be a positive integer.");
  }
  return parsed;
}

function parseInteger(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}
