import { ARENA_ROOM_NAME } from "@blob/protocol";
import { matchMaker, Server, type AuthContext } from "@colyseus/core";
import { Encoder } from "@colyseus/schema";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { BlobArenaRoom, type BlobArenaRoomOptions } from "./BlobArenaRoom.js";
import { isValidVisitorId, LiveMetrics, PresenceRateLimiter, WebSocketUpgradeRateLimiter } from "./liveMetrics.js";

/**
 * A full room snapshot includes server-owned food and up to 32 participants.
 * Colyseus defaults to a small encoder buffer which is insufficient once Free
 * Mode adds its disclosed Arena Bots. This is transport capacity only: it
 * does not alter simulation state or client authority.
 */
export const ARENA_STATE_ENCODER_BUFFER_BYTES = 128 * 1024;
Encoder.BUFFER_SIZE = Math.max(Encoder.BUFFER_SIZE, ARENA_STATE_ENCODER_BUFFER_BYTES);

/** One process runs one canonical Free Mode round. Creating parallel rooms
 * once the 32-seat arena is full would create a misleading, unaudited second
 * match and lets an attacker amplify a join flood into simulation work. */
export const MAX_CONCURRENT_FREE_ARENAS = 1;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface GameServerHandle {
  listen(port: number, host?: string): Promise<number>;
  shutdown(): Promise<void>;
}

export function createGameServer(
  allowedOrigins = resolveAllowedOrigins(),
  roomOptions: BlobArenaRoomOptions = {},
): GameServerHandle {
  const app = express();
  const liveMetrics = new LiveMetrics();
  const presenceRateLimiter = new PresenceRateLimiter();
  const webSocketUpgradeRateLimiter = new WebSocketUpgradeRateLimiter();
  const matchmakeRateLimiter = new WebSocketUpgradeRateLimiter();
  const production = process.env.NODE_ENV === "production";
  configureColyseusIngress({ allowedOrigins, production, matchmakeRateLimiter });
  app.disable("x-powered-by");
  // Railway supplies one trusted proxy hop. This gives the short-lived
  // presence limiter a real client address without retaining that address.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1kb", strict: true }));
  app.use((_request, response, next) => {
    clearColyseusCorsHeaders(response);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  const browserCors = cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204
  });
  app.use((request, response, next) => {
    const origin = request.get("Origin");
    // CORS is not authentication. Still, do not invoke cors() at all for a
    // direct request or an untrusted Origin: its default fallback is `*`.
    if (!origin || !allowedOrigins.has(origin)) {
      next();
      return;
    }
    browserCors(request, response, next);
  });
  app.get("/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ service: "blob-game-server", status: "ok" });
  });
  app.get("/metrics", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(liveMetrics.snapshot());
  });
  app.post("/presence", (request, response) => {
    const origin = request.get("Origin");
    if (!origin || !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "PRESENCE_ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (!presenceRateLimiter.consume(request.ip)) {
      response.status(429).json({ error: "PRESENCE_RATE_LIMITED" });
      return;
    }
    const visitorId = request.body && typeof request.body === "object"
      ? (request.body as { visitorId?: unknown }).visitorId
      : undefined;
    if (!isValidVisitorId(visitorId)) {
      response.status(400).json({ error: "INVALID_VISITOR_ID" });
      return;
    }
    response.status(200).json(liveMetrics.recordVisitor(visitorId));
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      return;
    }
    const status = isRequestTooLargeError(error) ? 413 : 400;
    response.status(status).json({ error: status === 413 ? "REQUEST_TOO_LARGE" : "REQUEST_INVALID" });
  });

  const httpServer = createServer(app);
  configureHttpTimeouts(httpServer);
  const gameServer = new Server({
    transport: new WebSocketTransport({
      server: httpServer,
      // Colyseus already defaults to a 4 KiB frame ceiling and disables
      // compression. Keep these values explicit so an upstream default change
      // cannot silently reintroduce a decompression or large-frame attack.
      maxPayload: 4 * 1024,
      perMessageDeflate: false,
      verifyClient: (info: { origin: string; req: IncomingMessage }) => {
        const originAllowed = info.origin
          ? allowedOrigins.has(info.origin)
          : !production;
        return originAllowed && webSocketUpgradeRateLimiter.consume(info.req.socket.remoteAddress);
      }
    }),
    gracefullyShutdown: false,
    selectProcessIdToCreateRoom: async (roomName) => {
      if (roomName === ARENA_ROOM_NAME) {
        const existingArenas = await matchMaker.query({ name: ARENA_ROOM_NAME });
        if (existingArenas.length >= MAX_CONCURRENT_FREE_ARENAS) {
          throw new Error("Free Mode arena capacity is currently full.");
        }
      }
      return matchMaker.processId;
    }
  });
  gameServer.define(ARENA_ROOM_NAME, BlobArenaRoom, { ...roomOptions, liveMetrics });

  return {
    async listen(port: number, host = "0.0.0.0"): Promise<number> {
      await gameServer.listen(port, host);
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Game server did not bind to a TCP port.");
      }
      return address.port;
    },
    async shutdown(): Promise<void> {
      await gameServer.gracefullyShutdown(false);
    }
  };
}

export function resolveAllowedOrigins(environment: NodeJS.ProcessEnv = process.env): Set<string> {
  const configuredOrigins = environment.BLOB_WEB_ORIGIN
    ?.split(",")
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));
  if (configuredOrigins?.length) {
    return new Set(configuredOrigins);
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("BLOB_WEB_ORIGIN is required in production.");
  }
  return new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value.trim()).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function configureHttpTimeouts(server: HttpServer): void {
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
}

function configureColyseusIngress(input: {
  allowedOrigins: ReadonlySet<string>;
  production: boolean;
  matchmakeRateLimiter: WebSocketUpgradeRateLimiter;
}): void {
  // Colyseus defaults to wildcard CORS plus credentials for its /matchmake
  // router. Replace those mutable defaults before the server binds routes.
  const defaultCorsHeaders = matchMaker.controller.DEFAULT_CORS_HEADERS as Record<string, string>;
  delete defaultCorsHeaders["Access-Control-Allow-Origin"];
  delete defaultCorsHeaders["Access-Control-Allow-Credentials"];
  defaultCorsHeaders["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  defaultCorsHeaders["Access-Control-Max-Age"] = "600";
  matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
    const origin = headers.get("origin");
    return origin && input.allowedOrigins.has(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
  };

  matchMaker.controller.invokeMethod = async (method, roomName, clientOptions = {}, authOptions?: AuthContext) => {
    if (roomName === ARENA_ROOM_NAME) {
      const origin = authOptions?.headers.get("origin") ?? undefined;
      const originAllowed = origin
        ? input.allowedOrigins.has(origin)
        : !input.production;
      const sourceAddress = Array.isArray(authOptions?.ip) ? authOptions?.ip[0] : authOptions?.ip;
      // Colyseus' HTTP adapter does not expose an IP in every local/test
      // transport. Keep a single bounded fallback bucket rather than turning
      // that absence into an unlimited or fail-open path.
      if (!originAllowed || !input.matchmakeRateLimiter.consume(sourceAddress ?? "unattributed")) {
        throw new Error("Matchmaking request rejected.");
      }
    }
    return invokeMatchmakerMethod(method, roomName, clientOptions, authOptions);
  };
}

const invokeMatchmakerMethod = matchMaker.controller.invokeMethod.bind(matchMaker.controller);

function clearColyseusCorsHeaders(response: Response): void {
  response.removeHeader("Access-Control-Allow-Origin");
  response.removeHeader("Access-Control-Allow-Credentials");
  response.removeHeader("Access-Control-Allow-Headers");
  response.removeHeader("Access-Control-Allow-Methods");
  response.removeHeader("Access-Control-Max-Age");
}

function isRequestTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "type" in error
    && (error as { type?: unknown }).type === "entity.too.large";
}
