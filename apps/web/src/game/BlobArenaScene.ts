import type { Room } from "@colyseus/sdk";
import Phaser from "phaser";
import {
  type TouchJoystickHand,
  TOUCH_JOYSTICK_RADIUS,
  canStartTouchJoystick,
  renderInterpolationAlpha,
  targetArenaZoom,
  touchJoystickAnchor,
} from "./arenaPresentation.js";

export interface NetworkPlayer {
  id: string;
  name: string;
  isBot: boolean;
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
  isBot: boolean;
  rank: number;
  mass: number;
  kills: number;
}

export interface NetworkFinalRanking {
  playerId: string;
  name: string;
  isBot: boolean;
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
  humanPlayerCount: number;
  botPlayerCount: number;
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
  humanPlayerCount: number;
  botPlayerCount: number;
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
const RENDER_TELEPORT_DISTANCE = 260;
const MOUSE_TARGET_STOP_DISTANCE = 8;

interface RenderedPlayerPosition {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  alive: boolean;
}

type DirectionKeys = Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

interface KeyboardControls {
  wasd: DirectionKeys;
  arrows: DirectionKeys;
}

export class BlobArenaScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private touchGraphics!: Phaser.GameObjects.Graphics;
  private intent = { x: 0, y: 0 };
  private lastUiUpdate = 0;
  private sendIntentEvent?: Phaser.Time.TimerEvent;
  private keyboard?: KeyboardControls;
  private lastLocalMass = 0;
  private collectPulseUntil = 0;
  private deathPulseUntil = 0;
  private mouseTarget: ScreenPosition | undefined;
  private activeTouchId: number | null = null;
  private touchOriginX = 0;
  private touchOriginY = 0;
  private touchCurrentX = 0;
  private touchCurrentY = 0;
  private touchHand: TouchJoystickHand = "right";
  private worldWidth = 0;
  private worldHeight = 0;
  private readonly renderedPlayerPositions = new Map<string, RenderedPlayerPosition>();

  constructor(
    private readonly room: Room,
    private readonly onUiState: (state: ArenaUiState) => void,
    initialTouchHand: TouchJoystickHand = "right",
  ) {
    super("blob-arena");
    this.touchHand = initialTouchHand;
  }

  setTouchHand(hand: TouchJoystickHand): void {
    if (this.touchHand === hand) {
      return;
    }
    this.touchHand = hand;
    this.activeTouchId = null;
    this.intent = { x: 0, y: 0 };
    this.sendIntent();
  }

  getTouchHand(): TouchJoystickHand {
    return this.touchHand;
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
    document.addEventListener("visibilitychange", this.clearHiddenTabIntent);
    const keyboardPlugin = this.input.keyboard;
    if (keyboardPlugin) {
      // Phaser's addKeys accepts one key code per action. Keeping WASD and
      // arrows as explicit bindings avoids silently creating invalid array
      // keys, while addKeys captures the browser defaults for the arrows.
      this.keyboard = {
        wasd: keyboardPlugin.addKeys({
          up: Phaser.Input.Keyboard.KeyCodes.W,
          down: Phaser.Input.Keyboard.KeyCodes.S,
          left: Phaser.Input.Keyboard.KeyCodes.A,
          right: Phaser.Input.Keyboard.KeyCodes.D,
        }) as DirectionKeys,
        arrows: keyboardPlugin.addKeys({
          up: Phaser.Input.Keyboard.KeyCodes.UP,
          down: Phaser.Input.Keyboard.KeyCodes.DOWN,
          left: Phaser.Input.Keyboard.KeyCodes.LEFT,
          right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        }) as DirectionKeys,
      };
    }
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
      document.removeEventListener("visibilitychange", this.clearHiddenTabIntent);
      this.sendIntentEvent?.remove();
      this.room.send("input", { x: 0, y: 0 });
    });
  }

  override update(time: number, delta: number): void {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    if (!state?.players || !state.food) {
      return;
    }

    this.updateWorldBounds(state);
    this.syncRenderedPlayerPositions(state, delta);
    const localPlayer = state.players.get(this.room.sessionId);
    if (localPlayer) {
      if (localPlayer.alive && state.phase === "ACTIVE") {
        if (this.hasKeyboardInput()) {
          this.applyKeyboardIntent();
        } else if (this.activeTouchId === null) {
          this.applyMouseIntent();
        }
      } else {
        this.intent = { x: 0, y: 0 };
        this.mouseTarget = undefined;
      }
      const renderedLocalPlayer = this.getRenderedPosition(localPlayer);
      this.cameras.main.centerOn(renderedLocalPlayer.x, renderedLocalPlayer.y);
      const targetZoom = targetArenaZoom(localPlayer.mass, this.isCompactViewport());
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
        humanPlayerCount: state.humanPlayerCount,
        botPlayerCount: state.botPlayerCount,
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
      const anchor = this.getTouchJoystickAnchor();
      if (!canStartTouchJoystick(pointer, anchor)) {
        return;
      }
      this.activeTouchId = pointer.id;
      this.mouseTarget = undefined;
      this.touchOriginX = anchor.x;
      this.touchOriginY = anchor.y;
      this.touchCurrentX = pointer.x;
      this.touchCurrentY = pointer.y;
      this.updateTouchIntent(pointer);
      this.sendIntent();
      return;
    }
    this.updateMouseIntent(pointer);
    this.sendIntent();
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
      this.sendIntent();
      return;
    }
    if (!pointer.wasTouch) {
      this.clearPointerIntent();
    }
  }

  private clearPointerIntent(): void {
    if (this.activeTouchId === null && !this.hasKeyboardInput()) {
      this.intent = { x: 0, y: 0 };
      this.mouseTarget = undefined;
      this.sendIntent();
    }
  }

  private clearHiddenTabIntent(): void {
    if (document.hidden) {
      this.activeTouchId = null;
      this.mouseTarget = undefined;
      this.intent = { x: 0, y: 0 };
      this.sendIntent();
    }
  }

  private updateMouseIntent(pointer: Phaser.Input.Pointer): void {
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer?.alive) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    this.mouseTarget = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.applyMouseIntent();
  }

  private applyMouseIntent(): void {
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer?.alive || !this.mouseTarget) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    const renderedPlayer = this.getRenderedPosition(localPlayer);
    const deltaX = this.mouseTarget.x - renderedPlayer.x;
    const deltaY = this.mouseTarget.y - renderedPlayer.y;
    if (Math.hypot(deltaX, deltaY) <= MOUSE_TARGET_STOP_DISTANCE) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    this.setIntentFromDelta(deltaX, deltaY);
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
    const x = Number(this.isDirectionPressed("right")) - Number(this.isDirectionPressed("left"));
    const y = Number(this.isDirectionPressed("down")) - Number(this.isDirectionPressed("up"));
    if (x === 0 && y === 0) {
      return;
    }
    this.mouseTarget = undefined;
    this.setIntentFromDelta(x, y);
  }

  private hasKeyboardInput(): boolean {
    return this.isDirectionPressed("up") || this.isDirectionPressed("down") || this.isDirectionPressed("left") || this.isDirectionPressed("right");
  }

  private isDirectionPressed(direction: keyof DirectionKeys): boolean {
    return this.keyboard?.wasd[direction].isDown === true || this.keyboard?.arrows[direction].isDown === true;
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

  private syncRenderedPlayerPositions(state: NetworkArenaState, delta: number): void {
    const interpolationAlpha = renderInterpolationAlpha(delta);
    const presentPlayerIds = new Set<string>();
    state.players.forEach((player) => {
      presentPlayerIds.add(player.id);
      const previous = this.renderedPlayerPositions.get(player.id);
      const distanceToTarget = previous ? Math.hypot(player.x - previous.targetX, player.y - previous.targetY) : 0;
      const shouldSnap = !previous || !player.alive || previous.alive !== player.alive || distanceToTarget > RENDER_TELEPORT_DISTANCE;
      if (shouldSnap) {
        this.renderedPlayerPositions.set(player.id, {
          x: player.x,
          y: player.y,
          targetX: player.x,
          targetY: player.y,
          alive: player.alive,
        });
        return;
      }
      previous.targetX = player.x;
      previous.targetY = player.y;
      previous.alive = player.alive;
      previous.x = Phaser.Math.Linear(previous.x, previous.targetX, interpolationAlpha);
      previous.y = Phaser.Math.Linear(previous.y, previous.targetY, interpolationAlpha);
    });
    for (const playerId of this.renderedPlayerPositions.keys()) {
      if (!presentPlayerIds.has(playerId)) {
        this.renderedPlayerPositions.delete(playerId);
      }
    }
  }

  private getRenderedPosition(player: NetworkPlayer): ScreenPosition {
    const rendered = this.renderedPlayerPositions.get(player.id);
    return rendered ? { x: rendered.x, y: rendered.y } : { x: player.x, y: player.y };
  }

  private getTouchJoystickAnchor(): ScreenPosition {
    return touchJoystickAnchor(this.scale.width, this.scale.height, this.touchHand);
  }

  private isCompactViewport(): boolean {
    return this.scale.width <= 680 || (window.matchMedia?.("(pointer: coarse)").matches ?? false);
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
      this.drawPlayer(player, player.id === localPlayerId, state.serverTime, time, this.getRenderedPosition(player));
    });
  }

  private drawPlayer(
    player: NetworkPlayer,
    isLocalPlayer: boolean,
    serverTime: number,
    time: number,
    position: ScreenPosition,
  ): void {
    const { x, y } = position;
    const radius = Math.max(18, Math.sqrt(Math.max(0, player.mass)) * 3.2);
    const color = colorForPlayer(player.id);
    const wobble = player.alive ? Math.sin((time + x + y) / 145) * Math.min(2.2, radius * 0.05) : 0;
    this.graphics.fillStyle(0x000000, 0.18);
    this.graphics.fillCircle(x + 4, y + radius * 0.25, radius * 1.02);
    this.graphics.fillStyle(color, player.alive ? 1 : 0.2);
    this.graphics.fillCircle(x, y + wobble, radius);
    this.graphics.fillStyle(0xffffff, 0.16);
    this.graphics.fillCircle(x - radius * 0.28, y - radius * 0.3 + wobble, radius * 0.24);
    if (isLocalPlayer) {
      this.graphics.lineStyle(3, 0xfff7f2, 0.95);
      this.graphics.strokeCircle(x, y + wobble, radius + 5);
      if (time < this.collectPulseUntil) {
        this.graphics.lineStyle(3, 0xffd34f, (this.collectPulseUntil - time) / 180);
        this.graphics.strokeCircle(x, y + wobble, radius + 12);
      }
      if (time < this.deathPulseUntil) {
        this.graphics.lineStyle(4, 0xff668e, (this.deathPulseUntil - time) / 320);
        this.graphics.strokeCircle(x, y + wobble, radius + 18);
      }
    } else if (player.isBot) {
      this.graphics.lineStyle(2, 0x8e6bff, 0.95);
      this.graphics.strokeCircle(x, y + wobble, radius + 3);
      this.graphics.fillStyle(0xfff7f2, 0.85);
      this.graphics.fillCircle(x, y - radius * 0.62 + wobble, Math.max(3, radius * 0.1));
    } else if (player.spawnProtectedUntil > serverTime) {
      this.graphics.lineStyle(2, 0xffd34f, 0.95);
      this.graphics.strokeCircle(x, y + wobble, radius + 3);
    }
    if (!player.alive) {
      return;
    }
    this.graphics.fillStyle(0x260719, 1);
    this.graphics.fillCircle(x - radius * 0.22, y - radius * 0.02 + wobble, Math.max(3, radius * 0.1));
    this.graphics.fillCircle(x + radius * 0.22, y - radius * 0.02 + wobble, Math.max(3, radius * 0.1));
    this.graphics.fillStyle(0xfff7f2, 0.78);
    this.graphics.fillCircle(x - radius * 0.25, y - radius * 0.07 + wobble, Math.max(1.2, radius * 0.033));
    this.graphics.fillCircle(x + radius * 0.19, y - radius * 0.07 + wobble, Math.max(1.2, radius * 0.033));
  }

  private drawTouchJoystick(): void {
    this.touchGraphics.clear();
    if (!this.isCompactViewport()) {
      return;
    }
    const anchor = this.getTouchJoystickAnchor();
    const deltaX = this.activeTouchId === null ? 0 : this.touchCurrentX - this.touchOriginX;
    const deltaY = this.activeTouchId === null ? 0 : this.touchCurrentY - this.touchOriginY;
    const distance = Math.hypot(deltaX, deltaY);
    const scale = distance > TOUCH_JOYSTICK_RADIUS ? TOUCH_JOYSTICK_RADIUS / distance : 1;
    this.touchGraphics.fillStyle(0x160717, 0.35);
    this.touchGraphics.fillCircle(anchor.x, anchor.y, TOUCH_JOYSTICK_RADIUS);
    this.touchGraphics.lineStyle(2, 0xfff7f2, this.activeTouchId === null ? 0.2 : 0.46);
    this.touchGraphics.strokeCircle(anchor.x, anchor.y, TOUCH_JOYSTICK_RADIUS);
    this.touchGraphics.fillStyle(0xf42b68, this.activeTouchId === null ? 0.28 : 0.7);
    this.touchGraphics.fillCircle(anchor.x + deltaX * scale, anchor.y + deltaY * scale, 23);
  }
}

interface ScreenPosition {
  x: number;
  y: number;
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
