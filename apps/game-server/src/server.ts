import { ARENA_ROOM_NAME } from "@blob/protocol";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { BlobArenaRoom } from "./BlobArenaRoom.js";

export interface GameServerHandle {
  listen(port: number, host?: string): Promise<number>;
  shutdown(): Promise<void>;
}

export function createGameServer(allowedOrigins = resolveAllowedOrigins()): GameServerHandle {
  const app = express();
  app.disable("x-powered-by");
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

  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({
      server: httpServer,
      verifyClient: ({ origin }: { origin: string }) => !origin || allowedOrigins.has(origin)
    }),
    gracefullyShutdown: false
  });
  gameServer.define(ARENA_ROOM_NAME, BlobArenaRoom);

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
