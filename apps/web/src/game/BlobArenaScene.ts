import type { Room } from "@colyseus/sdk";
import Phaser from "phaser";

interface NetworkPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  mass: number;
  score: number;
  kills: number;
  deaths: number;
  rank: number;
  alive: boolean;
  spawnProtectedUntil: number;
}

interface NetworkFood {
  id: string;
  x: number;
  y: number;
  mass: number;
}

interface NetworkCollection<T> {
  get(key: string): T | undefined;
  forEach(callback: (entry: T, key: string) => void): void;
}

interface NetworkArenaState {
  players: NetworkCollection<NetworkPlayer>;
  food: NetworkCollection<NetworkFood>;
  phase: string;
  matchNumber: number;
  remainingMs: number;
}

export interface ArenaUiState {
  phase: string;
  matchNumber: number;
  remainingMs: number;
  players: NetworkPlayer[];
}

export class BlobArenaScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private intent = { x: 0, y: 0 };
  private lastUiUpdate = 0;
  private sendIntentEvent?: Phaser.Time.TimerEvent;

  constructor(
    private readonly room: Room,
    private readonly onUiState: (state: ArenaUiState) => void
  ) {
    super("blob-arena");
  }

  create(): void {
    this.graphics = this.add.graphics();
    this.cameras.main.setBounds(0, 0, 2_400, 1_400);
    this.cameras.main.setZoom(0.82);
    this.input.on("pointermove", this.updateIntent, this);
    this.input.on("pointerdown", this.updateIntent, this);
    this.sendIntentEvent = this.time.addEvent({
      delay: 50,
      loop: true,
      callback: () => this.room.send("input", this.intent)
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off("pointermove", this.updateIntent, this);
      this.input.off("pointerdown", this.updateIntent, this);
      this.sendIntentEvent?.remove();
    });
  }

  override update(time: number): void {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    if (!state?.players || !state.food) {
      return;
    }

    const localPlayer = state.players.get(this.room.sessionId);
    if (localPlayer) {
      this.cameras.main.centerOn(localPlayer.x, localPlayer.y);
    }
    this.drawArena(state, localPlayer?.id);

    if (time - this.lastUiUpdate >= 100) {
      this.lastUiUpdate = time;
      const players: NetworkPlayer[] = [];
      state.players.forEach((player) => players.push({ ...player }));
      this.onUiState({
        phase: state.phase,
        matchNumber: state.matchNumber,
        remainingMs: state.remainingMs,
        players: players.sort((left, right) => left.rank - right.rank)
      });
    }
  }

  private updateIntent(pointer: Phaser.Input.Pointer): void {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    const localPlayer = state?.players?.get(this.room.sessionId);
    if (!localPlayer || !localPlayer.alive) {
      this.intent = { x: 0, y: 0 };
      return;
    }

    const deltaX = pointer.worldX - localPlayer.x;
    const deltaY = pointer.worldY - localPlayer.y;
    const magnitude = Math.hypot(deltaX, deltaY);
    this.intent = magnitude > 0
      ? { x: deltaX / magnitude, y: deltaY / magnitude }
      : { x: 0, y: 0 };
  }

  private drawArena(state: NetworkArenaState, localPlayerId: string | undefined): void {
    this.graphics.clear();
    this.graphics.fillStyle(0x160717, 1);
    this.graphics.fillRect(0, 0, 2_400, 1_400);
    this.graphics.lineStyle(1, 0xffffff, 0.06);
    for (let x = 0; x <= 2_400; x += 80) {
      this.graphics.lineBetween(x, 0, x, 1_400);
    }
    for (let y = 0; y <= 1_400; y += 80) {
      this.graphics.lineBetween(0, y, 2_400, y);
    }
    this.graphics.lineStyle(6, 0xf42b68, 0.7);
    this.graphics.strokeRect(0, 0, 2_400, 1_400);

    state.food.forEach((pellet) => {
      this.graphics.fillStyle(0xffd34f, 1);
      this.graphics.fillCircle(pellet.x, pellet.y, 7);
    });
    state.players.forEach((player) => {
      this.drawPlayer(player, player.id === localPlayerId);
    });
  }

  private drawPlayer(player: NetworkPlayer, isLocalPlayer: boolean): void {
    const radius = Math.max(16, Math.sqrt(Math.max(0, player.mass)) * 5);
    const color = colorForPlayer(player.id);
    this.graphics.fillStyle(color, player.alive ? 1 : 0.25);
    this.graphics.fillCircle(player.x, player.y, radius);
    if (isLocalPlayer) {
      this.graphics.lineStyle(3, 0xfff7f2, 0.95);
      this.graphics.strokeCircle(player.x, player.y, radius + 5);
    } else if (player.spawnProtectedUntil > Date.now()) {
      this.graphics.lineStyle(2, 0xffd34f, 0.95);
      this.graphics.strokeCircle(player.x, player.y, radius + 3);
    }
    if (!player.alive) {
      return;
    }
    this.graphics.fillStyle(0x260719, 1);
    this.graphics.fillCircle(player.x - radius * 0.22, player.y - radius * 0.02, Math.max(3, radius * 0.1));
    this.graphics.fillCircle(player.x + radius * 0.22, player.y - radius * 0.02, Math.max(3, radius * 0.1));
  }
}

function colorForPlayer(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return [0xf42b68, 0x8e6bff, 0x21c7a8, 0xff9d3d, 0x42a5f5][hash % 5] ?? 0xf42b68;
}
