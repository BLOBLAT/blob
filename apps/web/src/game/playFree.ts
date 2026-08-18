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
  options.onConnectionStatus("Connecting to the authoritative arena…");
  const client = new Client(resolveGameServerUrl());
  const room = await client.joinOrCreate(ARENA_ROOM_NAME, { name: getLocalPlayerName() });
  let disposed = false;
  const game = createPhaserGame(options.canvasHost, room, options.onUiState);

  room.onLeave(() => {
    if (!disposed) {
      options.onConnectionStatus("Connection closed. Refresh to reconnect.");
    }
  });
  options.onConnectionStatus("Connected — server state is live.");

  return {
    async leave(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      game.destroy(true);
      await room.leave();
    }
  };
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
  return configured || `${window.location.protocol}//${window.location.hostname}:2567`;
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
