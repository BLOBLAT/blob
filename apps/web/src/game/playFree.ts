import { type Room } from "@colyseus/sdk";
import { ARENA_ROOM_NAME, ServerEvent } from "@blob/protocol";
import Phaser from "phaser";
import { ArenaUiState, BlobArenaScene } from "./BlobArenaScene.js";
import type { TouchJoystickHand } from "./arenaPresentation.js";
import { createGameClient } from "./gameClient.js";
import { getGamePlayerName } from "../identity.js";
import { GameServerConfigurationError, resolveGameServerUrl } from "./serverUrl.js";

export interface FreeGameController {
  leave(): Promise<void>;
  sendChat(text: string): void;
  setTouchHand(hand: TouchJoystickHand): void;
  getTouchHand(): TouchJoystickHand;
  setTouchIntent(input: { x: number; y: number }): void;
  clearTouchIntent(): void;
}

export interface StartFreeGameOptions {
  canvasHost: HTMLElement;
  onUiState(state: ArenaUiState): void;
  onConnectionStatus(message: string): void;
  getProfileTicket?(): Promise<string | undefined>;
  onChatMessage?(message: ArenaChatMessage): void;
  onChatRejected?(code: string): void;
  initialTouchHand?: TouchJoystickHand;
}

export interface ArenaChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  sentAt: number;
}

export async function startFreeGame(options: StartFreeGameOptions): Promise<FreeGameController> {
  let disposed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | undefined;
  let activeRoom: Room | undefined;
  let game: Phaser.Game | undefined;
  let arenaScene: BlobArenaScene | undefined;
  let touchHand: TouchJoystickHand = options.initialTouchHand ?? "right";

  const connect = async (isReconnect = false): Promise<void> => {
    options.onConnectionStatus(isReconnect
      ? `Reconnecting to the arena (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`
      : "Connecting to the authoritative arena…");

    const gameServerUrl = resolveGameServerUrl();
    options.onConnectionStatus("Checking the game server…");
    await verifyGameServerHealth(gameServerUrl);
    let profileTicket: string | undefined;
    try {
      profileTicket = await options.getProfileTicket?.();
    } catch (error) {
      console.warn("[BLOB] profile identity ticket was unavailable; joining anonymously", error);
    }
    const client = createGameClient(gameServerUrl);
    const room = await withConnectionTimeout(
      client.joinOrCreate(ARENA_ROOM_NAME, {
        name: getGamePlayerName(),
        ...(profileTicket ? { profileTicket } : {})
      })
    );

    if (disposed) {
      await room.leave();
      return;
    }

    activeRoom = room;
    // State patches drive rendering. Register the server's transient gameplay
    // events as well so Colyseus does not emit a console warning for every
    // collected pellet (which can itself make a busy arena feel sluggish).
    for (const event of [
      ServerEvent.PLAYER_JOINED,
      ServerEvent.PLAYER_DIED,
      ServerEvent.FOOD_EATEN,
      ServerEvent.PLAYER_ELIMINATED,
      ServerEvent.ROUND_STARTED,
      ServerEvent.ROUND_FINISHED,
      ServerEvent.MATCH_FINALIZED,
    ]) {
      room.onMessage(event, () => undefined);
    }
    room.onMessage(ServerEvent.CHAT_MESSAGE, (message: ArenaChatMessage) => options.onChatMessage?.(message));
    room.onMessage(ServerEvent.CHAT_REJECTED, (event: { code?: unknown }) => {
      options.onChatRejected?.(typeof event.code === "string" ? event.code : "CHAT_INVALID");
    });
    game?.destroy(true);
    const createdGame = createPhaserGame(options.canvasHost, room, options.onUiState);
    game = createdGame.game;
    arenaScene = createdGame.scene;
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
    arenaScene = undefined;
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
      arenaScene = undefined;
      await activeRoom?.leave();
    },
    sendChat(text: string): void {
      if (!activeRoom || disposed) {
        return;
      }
      activeRoom.send("chat_send", { text });
    },
    setTouchHand(hand: TouchJoystickHand): void {
      touchHand = hand;
      arenaScene?.clearTouchIntent();
    },
    getTouchHand(): TouchJoystickHand {
      return touchHand;
    },
    setTouchIntent(input: { x: number; y: number }): void {
      if (disposed) {
        return;
      }
      arenaScene?.setTouchIntent(input.x, input.y);
    },
    clearTouchIntent(): void {
      arenaScene?.clearTouchIntent();
    }
  };
}

const CONNECTION_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 1_500;
const MAX_RECONNECT_ATTEMPTS = 3;

export class GameServerHealthError extends Error {
  constructor() {
    super("The game server health check failed.");
  }
}

function createPhaserGame(
  canvasHost: HTMLElement,
  room: Room,
  onUiState: (state: ArenaUiState) => void,
): { game: Phaser.Game; scene: BlobArenaScene } {
  const scene = new BlobArenaScene(room, onUiState);
  return {
    scene,
    game: new Phaser.Game({
    type: Phaser.AUTO,
    parent: canvasHost,
    backgroundColor: "#160717",
    width: Math.max(320, canvasHost.clientWidth),
    height: Math.max(320, canvasHost.clientHeight),
    scene: [scene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    audio: { noAudio: true }
    }),
  };
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
