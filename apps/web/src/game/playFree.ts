import { Client, type Room } from "@colyseus/sdk";
import { ARENA_ROOM_NAME, ServerEvent } from "@blob/protocol";
import Phaser from "phaser";
import { ArenaUiState, BlobArenaScene } from "./BlobArenaScene.js";
import { getGamePlayerName } from "../identity.js";

export interface FreeGameController {
  leave(): Promise<void>;
}

export interface StartFreeGameOptions {
  canvasHost: HTMLElement;
  onUiState(state: ArenaUiState): void;
  onConnectionStatus(message: string): void;
}

export async function startFreeGame(options: StartFreeGameOptions): Promise<FreeGameController> {
  let disposed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | undefined;
  let activeRoom: Room | undefined;
  let game: Phaser.Game | undefined;

  const connect = async (isReconnect = false): Promise<void> => {
    options.onConnectionStatus(isReconnect
      ? `Reconnecting to the arena (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`
      : "Connecting to the authoritative arena…");

    const gameServerUrl = resolveGameServerUrl();
    options.onConnectionStatus("Checking the game server…");
    await verifyGameServerHealth(gameServerUrl);
    const client = new Client(gameServerUrl);
    const room = await withConnectionTimeout(
      client.joinOrCreate(ARENA_ROOM_NAME, { name: getGamePlayerName() })
    );

    if (disposed) {
      await room.leave();
      return;
    }

    activeRoom = room;
    for (const event of Object.values(ServerEvent)) {
      room.onMessage(event, () => undefined);
    }
    game?.destroy(true);
    game = createPhaserGame(options.canvasHost, room, options.onUiState);
    reconnectAttempts = 0;

    room.onLeave(() => {
      if (!disposed && activeRoom === room) {
        scheduleReconnect();
      }
    });
    options.onConnectionStatus("Connected — server state is live.");
  };

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== undefined) {
      return;
    }

    game?.destroy(true);
    game = undefined;
    activeRoom = undefined;
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      options.onConnectionStatus("Server unavailable — use Retry to reconnect.");
      return;
    }

    options.onConnectionStatus(`Connection lost — retrying (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void connect(true).catch(() => scheduleReconnect());
    }, RECONNECT_DELAY_MS);
  };

  await connect();

  return {
    async leave(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      game?.destroy(true);
      await activeRoom?.leave();
    }
  };
}

const CONNECTION_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 1_500;
const MAX_RECONNECT_ATTEMPTS = 3;

export class GameServerConfigurationError extends Error {
  constructor() {
    super("The game server is not configured for this deployment.");
  }
}

export class GameServerHealthError extends Error {
  constructor() {
    super("The game server health check failed.");
  }
}

function createPhaserGame(canvasHost: HTMLElement, room: Room, onUiState: (state: ArenaUiState) => void): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: canvasHost,
    backgroundColor: "#160717",
    width: Math.max(320, canvasHost.clientWidth),
    height: Math.max(320, canvasHost.clientHeight),
    scene: [new BlobArenaScene(room, onUiState)],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    audio: { noAudio: true }
  });
}

function resolveGameServerUrl(): string {
  const configured = import.meta.env.VITE_GAME_SERVER_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (import.meta.env.DEV) {
    return "http://127.0.0.1:2567";
  }
  throw new GameServerConfigurationError();
}

async function verifyGameServerHealth(gameServerUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await withConnectionTimeout(fetch(new URL("/health", `${gameServerUrl}/`), {
      headers: { Accept: "application/json" }
    }));
  } catch {
    throw new GameServerHealthError();
  }

  if (!response.ok) {
    throw new GameServerHealthError();
  }

  try {
    const body: unknown = await response.json();
    if (!isHealthyResponse(body)) {
      throw new GameServerHealthError();
    }
  } catch (error) {
    if (error instanceof GameServerHealthError) {
      throw error;
    }
    throw new GameServerHealthError();
  }
}

function isHealthyResponse(value: unknown): value is { status: "ok" } {
  return typeof value === "object" && value !== null && "status" in value && value.status === "ok";
}

function withConnectionTimeout<T>(connection: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Connection timed out after 8 seconds."));
    }, CONNECTION_TIMEOUT_MS);
    connection.then(
      (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
