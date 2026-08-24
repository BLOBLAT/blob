import { ARENA_ROOM_NAME } from "@blob/protocol";
import { Server } from "@colyseus/core";
import { Encoder } from "@colyseus/schema";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { BlobArenaRoom, type BlobArenaRoomOptions } from "./BlobArenaRoom.js";
import { isValidVisitorId, LiveMetrics, PresenceRateLimiter } from "./liveMetrics.js";

/**
 * A full room snapshot includes server-owned food and up to 32 participants.
 * Colyseus defaults to a small encoder buffer which is insufficient once Free
 * Mode adds its disclosed Arena Bots. This is transport capacity only: it
 * does not alter simulation state or client authority.
 */
export const ARENA_STATE_ENCODER_BUFFER_BYTES = 128 * 1024;
Encoder.BUFFER_SIZE = Math.max(Encoder.BUFFER_SIZE, ARENA_STATE_ENCODER_BUFFER_BYTES);

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
  app.disable("x-powered-by");
  // Railway supplies one trusted proxy hop. This gives the short-lived
  // presence limiter a real client address without retaining that address.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1kb", strict: true }));
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    optionsSuccessStatus: 204
  }));
  app.get("/health", (_request, response) => {
    response.status(200).json({ service: "blob-game-server", status: "ok" });
  });
  app.get("/metrics", (_request, response) => {
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

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({
      server: httpServer,
      verifyClient: ({ origin }: { origin: string }) => !origin || allowedOrigins.has(origin)
    }),
    gracefullyShutdown: false
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

function resolveAllowedOrigins(): Set<string> {
  const configuredOrigins = process.env.BLOB_WEB_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean);
  return new Set(configuredOrigins?.length ? configuredOrigins : ["http://127.0.0.1:5173", "http://localhost:5173"]);
}
