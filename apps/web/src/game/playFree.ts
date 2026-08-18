import { Client, type Room } from "@colyseus/sdk";
import { ARENA_ROOM_NAME } from "@blob/protocol";
import Phaser from "phaser";
import { ArenaUiState, BlobArenaScene } from "./BlobArenaScene.js";

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

    const client = new Client(resolveGameServerUrl());
    const room = await withConnectionTimeout(
      client.joinOrCreate(ARENA_ROOM_NAME, { name: getLocalPlayerName() })
    );

    if (disposed) {
      await room.leave();
      return;
    }

    activeRoom = room;
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
  throw new Error("Game server URL is not configured. Set VITE_GAME_SERVER_URL in Vercel and redeploy.");
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

function getLocalPlayerName(): string {
  const key = "blob.free-player-name";
  const existing = window.localStorage.getItem(key);
  if (existing && /^[A-Za-z0-9 _-]{3,16}$/.test(existing)) {
    return existing;
  }
  const suffix = String(Date.now()).slice(-5);
  const name = `BLOB-${suffix}`;
  window.localStorage.setItem(key, name);
  return name;
}
