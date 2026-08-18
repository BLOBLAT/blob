import type { Room } from "@colyseus/sdk";
import Phaser from "phaser";

export interface NetworkPlayer {
  id: string;
  name: string;
  x: number;
  y: number;
  mass: number;
  score: number;
  kills: number;
  deaths: number;
  foodCollected: number;
  survivalTimeMs: number;
  rank: number;
  alive: boolean;
  inRound: boolean;
  spawnProtectedUntil: number;
}

export interface NetworkLeaderboardEntry {
  playerId: string;
  name: string;
  rank: number;
  mass: number;
  kills: number;
}

export interface NetworkFinalRanking {
  playerId: string;
  name: string;
  rank: number;
  finalMass: number;
  foodCollected: number;
  eliminations: number;
  deaths: number;
  survivalTimeMs: number;
}

export interface NetworkRoundResult {
  available: boolean;
  matchId: string;
  roundId: string;
  mode: string;
  finalizedAt: number;
  rankings: NetworkCollection<NetworkFinalRanking>;
}

interface NetworkFood {
  id: string;
  x: number;
  y: number;
  mass: number;
  radius: number;
}

interface NetworkCollection<T> {
  get(key: string): T | undefined;
  forEach(callback: (entry: T, key: string) => void): void;
}

interface NetworkArenaState {
  players: NetworkCollection<NetworkPlayer>;
  food: NetworkCollection<NetworkFood>;
  leaderboard: NetworkCollection<NetworkLeaderboardEntry>;
  result: NetworkRoundResult;
  phase: string;
  mode: string;
  matchNumber: number;
  matchId: string;
  roundId: string;
  serverTime: number;
  remainingMs: number;
  matchmakingPlayerCount: number;
  worldWidth: number;
  worldHeight: number;
}

export interface ArenaUiState {
  phase: string;
  mode: string;
  matchNumber: number;
  matchId: string;
  roundId: string;
  remainingMs: number;
  matchmakingPlayerCount: number;
  players: NetworkPlayer[];
  leaderboard: NetworkLeaderboardEntry[];
  localPlayer?: NetworkPlayer;
  result?: {
    matchId: string;
    roundId: string;
    rankings: NetworkFinalRanking[];
  };
}

const INPUT_SEND_INTERVAL_MS = 50;
const POINTER_INTENT_TIMEOUT_MS = 140;
const TOUCH_JOYSTICK_RADIUS = 66;

export class BlobArenaScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private touchGraphics!: Phaser.GameObjects.Graphics;
  private intent = { x: 0, y: 0 };
  private lastUiUpdate = 0;
  private sendIntentEvent?: Phaser.Time.TimerEvent;
  private keyboard?: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private lastLocalMass = 0;
  private collectPulseUntil = 0;
  private deathPulseUntil = 0;
  private pointerIntentUntil = 0;
  private activeTouchId: number | null = null;
  private touchOriginX = 0;
  private touchOriginY = 0;
  private touchCurrentX = 0;
  private touchCurrentY = 0;
  private worldWidth = 0;
  private worldHeight = 0;

  constructor(
    private readonly room: Room,
    private readonly onUiState: (state: ArenaUiState) => void,
  ) {
    super("blob-arena");
  }

  create(): void {
    this.graphics = this.add.graphics();
    this.touchGraphics = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.game.canvas.style.touchAction = "none";
    this.cameras.main.setZoom(0.84);
    this.input.on("pointermove", this.onPointerMove, this);
    this.input.on("pointerdown", this.onPointerDown, this);
    this.input.on("pointerup", this.onPointerUp, this);
    this.input.on("pointerupoutside", this.onPointerUp, this);
    this.input.on("gameout", this.clearPointerIntent, this);
    this.keyboard = this.input.keyboard?.addKeys({
      up: [Phaser.Input.Keyboard.KeyCodes.W, Phaser.Input.Keyboard.KeyCodes.UP],
      down: [Phaser.Input.Keyboard.KeyCodes.S, Phaser.Input.Keyboard.KeyCodes.DOWN],
      left: [Phaser.Input.Keyboard.KeyCodes.A, Phaser.Input.Keyboard.KeyCodes.LEFT],
      right: [Phaser.Input.Keyboard.KeyCodes.D, Phaser.Input.Keyboard.KeyCodes.RIGHT],
    }) as Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key> | undefined;
    this.sendIntentEvent = this.time.addEvent({
      delay: INPUT_SEND_INTERVAL_MS,
      loop: true,
      callback: () => this.sendIntent(),
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off("pointermove", this.onPointerMove, this);
      this.input.off("pointerdown", this.onPointerDown, this);
      this.input.off("pointerup", this.onPointerUp, this);
      this.input.off("pointerupoutside", this.onPointerUp, this);
      this.input.off("gameout", this.clearPointerIntent, this);
      this.sendIntentEvent?.remove();
      this.room.send("input", { x: 0, y: 0 });
    });
  }

  override update(time: number): void {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    if (!state?.players || !state.food) {
      return;
    }

    this.updateWorldBounds(state);
    const localPlayer = state.players.get(this.room.sessionId);
    if (localPlayer) {
      if (localPlayer.alive && state.phase === "ACTIVE") {
        this.applyKeyboardIntent();
        if (!this.hasKeyboardInput() && this.activeTouchId === null && time >= this.pointerIntentUntil) {
          this.intent = { x: 0, y: 0 };
        }
      } else {
        this.intent = { x: 0, y: 0 };
      }
      this.cameras.main.centerOn(localPlayer.x, localPlayer.y);
      const targetZoom = Phaser.Math.Clamp(0.96 - Math.sqrt(Math.max(0, localPlayer.mass)) * 0.011, 0.52, 0.88);
      this.cameras.main.setZoom(Phaser.Math.Linear(this.cameras.main.zoom, targetZoom, 0.08));
      if (localPlayer.alive && localPlayer.mass > this.lastLocalMass) {
        this.collectPulseUntil = time + 180;
      }
      if (!localPlayer.alive && this.lastLocalMass > 0) {
        this.deathPulseUntil = time + 320;
      }
      this.lastLocalMass = localPlayer.mass;
    }
    this.drawArena(state, localPlayer?.id, time);
    this.drawTouchJoystick();

    if (time - this.lastUiUpdate >= 100) {
      this.lastUiUpdate = time;
      const players = toArray(state.players).sort((left, right) => left.rank - right.rank);
      const leaderboard = toArray(state.leaderboard).sort((left, right) => left.rank - right.rank);
      const rankings = state.result?.available ? toArray(state.result.rankings).sort((left, right) => left.rank - right.rank) : [];
      this.onUiState({
        phase: state.phase,
        mode: state.mode,
        matchNumber: state.matchNumber,
        matchId: state.matchId,
        roundId: state.roundId,
        remainingMs: state.remainingMs,
        matchmakingPlayerCount: state.matchmakingPlayerCount,
        players,
        leaderboard,
        localPlayer: localPlayer ? { ...localPlayer } : undefined,
        result: state.result?.available ? {
          matchId: state.result.matchId,
          roundId: state.result.roundId,
          rankings,
        } : undefined,
      });
    }
  }

  private updateWorldBounds(state: NetworkArenaState): void {
    if (state.worldWidth <= 0 || state.worldHeight <= 0) {
      return;
    }
    if (state.worldWidth !== this.worldWidth || state.worldHeight !== this.worldHeight) {
      this.worldWidth = state.worldWidth;
      this.worldHeight = state.worldHeight;
      this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight);
    }
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (pointer.wasTouch) {
      this.activeTouchId = pointer.id;
      this.touchOriginX = pointer.x;
      this.touchOriginY = pointer.y;
      this.touchCurrentX = pointer.x;
      this.touchCurrentY = pointer.y;
      this.updateTouchIntent(pointer);
      return;
    }
    this.updateMouseIntent(pointer);
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.activeTouchId === pointer.id) {
      this.updateTouchIntent(pointer);
      return;
    }
    if (!pointer.wasTouch) {
      this.updateMouseIntent(pointer);
    }
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (this.activeTouchId === pointer.id) {
      this.activeTouchId = null;
      this.intent = { x: 0, y: 0 };
      return;
    }
    if (!pointer.wasTouch) {
      this.clearPointerIntent();
    }
  }

  private clearPointerIntent(): void {
    if (this.activeTouchId === null && !this.hasKeyboardInput()) {
      this.intent = { x: 0, y: 0 };
    }
  }

  private updateMouseIntent(pointer: Phaser.Input.Pointer): void {
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer?.alive) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    const deltaX = pointer.worldX - localPlayer.x;
    const deltaY = pointer.worldY - localPlayer.y;
    this.setIntentFromDelta(deltaX, deltaY);
    this.pointerIntentUntil = this.time.now + POINTER_INTENT_TIMEOUT_MS;
  }

  private updateTouchIntent(pointer: Phaser.Input.Pointer): void {
    this.touchCurrentX = pointer.x;
    this.touchCurrentY = pointer.y;
    this.setIntentFromDelta(pointer.x - this.touchOriginX, pointer.y - this.touchOriginY);
  }

  private setIntentFromDelta(deltaX: number, deltaY: number): void {
    const magnitude = Math.hypot(deltaX, deltaY);
    this.intent = magnitude > 4
      ? { x: deltaX / magnitude, y: deltaY / magnitude }
      : { x: 0, y: 0 };
  }

  private applyKeyboardIntent(): void {
    if (!this.keyboard) {
      return;
    }
    const x = Number(this.keyboard.right.isDown) - Number(this.keyboard.left.isDown);
    const y = Number(this.keyboard.down.isDown) - Number(this.keyboard.up.isDown);
    if (x === 0 && y === 0) {
      return;
    }
    this.setIntentFromDelta(x, y);
  }

  private hasKeyboardInput(): boolean {
    if (!this.keyboard) {
      return false;
    }
    return this.keyboard.up.isDown || this.keyboard.down.isDown || this.keyboard.left.isDown || this.keyboard.right.isDown;
  }

  private sendIntent(): void {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    const localPlayer = state?.players?.get(this.room.sessionId);
    const activeIntent = state?.phase === "ACTIVE" && localPlayer?.alive ? this.intent : { x: 0, y: 0 };
    this.room.send("input", activeIntent);
  }

  private getLocalPlayer(): NetworkPlayer | undefined {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    return state?.players?.get(this.room.sessionId);
  }

  private drawArena(state: NetworkArenaState, localPlayerId: string | undefined, time: number): void {
    const width = this.worldWidth || 2_200;
    const height = this.worldHeight || 1_360;
    this.graphics.clear();
    this.graphics.fillStyle(0x160717, 1);
    this.graphics.fillRect(0, 0, width, height);
    this.graphics.fillStyle(0x2a0c30, 0.28);
    for (let index = 0; index < 70; index += 1) {
      const x = ((index * 149) % width) + 8;
      const y = ((index * 223) % height) + 8;
      this.graphics.fillCircle(x, y, 1.2);
    }
    this.graphics.lineStyle(1, 0xffffff, 0.055);
    for (let x = 0; x <= width; x += 80) {
      this.graphics.lineBetween(x, 0, x, height);
    }
    for (let y = 0; y <= height; y += 80) {
      this.graphics.lineBetween(0, y, width, y);
    }
    this.graphics.lineStyle(6, 0xf42b68, 0.72);
    this.graphics.strokeRect(0, 0, width, height);

    state.food.forEach((pellet) => {
      const bob = Math.sin((time + pellet.x * 3) / 220) * 1.3;
      this.graphics.fillStyle(0xffd34f, 1);
      this.graphics.fillCircle(pellet.x, pellet.y + bob, pellet.radius || 7);
      this.graphics.fillStyle(0xfff7f2, 0.62);
      this.graphics.fillCircle(pellet.x - 2, pellet.y - 2 + bob, 2);
    });
    state.players.forEach((player) => {
      this.drawPlayer(player, player.id === localPlayerId, state.serverTime, time);
    });
  }

  private drawPlayer(player: NetworkPlayer, isLocalPlayer: boolean, serverTime: number, time: number): void {
    const radius = Math.max(18, Math.sqrt(Math.max(0, player.mass)) * 3.2);
    const color = colorForPlayer(player.id);
    const wobble = player.alive ? Math.sin((time + player.x + player.y) / 145) * Math.min(2.2, radius * 0.05) : 0;
    this.graphics.fillStyle(0x000000, 0.18);
    this.graphics.fillCircle(player.x + 4, player.y + radius * 0.25, radius * 1.02);
    this.graphics.fillStyle(color, player.alive ? 1 : 0.2);
    this.graphics.fillCircle(player.x, player.y + wobble, radius);
    this.graphics.fillStyle(0xffffff, 0.16);
    this.graphics.fillCircle(player.x - radius * 0.28, player.y - radius * 0.3 + wobble, radius * 0.24);
    if (isLocalPlayer) {
      this.graphics.lineStyle(3, 0xfff7f2, 0.95);
      this.graphics.strokeCircle(player.x, player.y + wobble, radius + 5);
      if (time < this.collectPulseUntil) {
        this.graphics.lineStyle(3, 0xffd34f, (this.collectPulseUntil - time) / 180);
        this.graphics.strokeCircle(player.x, player.y + wobble, radius + 12);
      }
      if (time < this.deathPulseUntil) {
        this.graphics.lineStyle(4, 0xff668e, (this.deathPulseUntil - time) / 320);
        this.graphics.strokeCircle(player.x, player.y + wobble, radius + 18);
      }
    } else if (player.spawnProtectedUntil > serverTime) {
      this.graphics.lineStyle(2, 0xffd34f, 0.95);
      this.graphics.strokeCircle(player.x, player.y + wobble, radius + 3);
    }
    if (!player.alive) {
      return;
    }
    this.graphics.fillStyle(0x260719, 1);
    this.graphics.fillCircle(player.x - radius * 0.22, player.y - radius * 0.02 + wobble, Math.max(3, radius * 0.1));
    this.graphics.fillCircle(player.x + radius * 0.22, player.y - radius * 0.02 + wobble, Math.max(3, radius * 0.1));
    this.graphics.fillStyle(0xfff7f2, 0.78);
    this.graphics.fillCircle(player.x - radius * 0.25, player.y - radius * 0.07 + wobble, Math.max(1.2, radius * 0.033));
    this.graphics.fillCircle(player.x + radius * 0.19, player.y - radius * 0.07 + wobble, Math.max(1.2, radius * 0.033));
  }

  private drawTouchJoystick(): void {
    this.touchGraphics.clear();
    if (this.activeTouchId === null) {
      return;
    }
    const deltaX = this.touchCurrentX - this.touchOriginX;
    const deltaY = this.touchCurrentY - this.touchOriginY;
    const distance = Math.hypot(deltaX, deltaY);
    const scale = distance > TOUCH_JOYSTICK_RADIUS ? TOUCH_JOYSTICK_RADIUS / distance : 1;
    this.touchGraphics.lineStyle(2, 0xfff7f2, 0.3);
    this.touchGraphics.strokeCircle(this.touchOriginX, this.touchOriginY, TOUCH_JOYSTICK_RADIUS);
    this.touchGraphics.fillStyle(0xf42b68, 0.5);
    this.touchGraphics.fillCircle(this.touchOriginX + deltaX * scale, this.touchOriginY + deltaY * scale, 23);
  }
}

function toArray<T>(collection: NetworkCollection<T>): T[] {
  const entries: T[] = [];
  collection.forEach((entry) => entries.push({ ...entry }));
  return entries;
}

function colorForPlayer(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return [0xf42b68, 0x8e6bff, 0x21c7a8, 0xff9d3d, 0x42a5f5][hash % 5] ?? 0xf42b68;
}
