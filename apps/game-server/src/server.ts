import { ARENA_ROOM_NAME } from "@blob/protocol";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { BlobArenaRoom, type BlobArenaRoomOptions } from "./BlobArenaRoom.js";
import { isValidVisitorId, LiveMetrics } from "./liveMetrics.js";

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
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1kb", strict: true }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed to access the game server."));
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
