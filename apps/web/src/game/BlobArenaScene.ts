import type { Room } from "@colyseus/sdk";
import Phaser from "phaser";
import {
  renderInterpolationAlpha,
  targetArenaZoom,
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

/**
 * The server accepts at most 25 non-zero inputs per second. Keep browser
 * updates just below that ceiling so an input is always admitted instead of
 * being dropped by the authoritative rate limiter.
 */
const INPUT_SEND_INTERVAL_MS = 45;
const INPUT_HEARTBEAT_INTERVAL_MS = 180;
const INPUT_CHANGE_EPSILON = 0.01;
const MOUSE_INTENT_HOLD_MS = 220;
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
  private intent = { x: 0, y: 0 };
  private lastUiUpdate = 0;
  private sendIntentEvent?: Phaser.Time.TimerEvent;
  private lastSentIntent = { x: 0, y: 0 };
  private lastIntentSentAt = Number.NEGATIVE_INFINITY;
  private keyboard?: KeyboardControls;
  private lastLocalMass = 0;
  private collectPulseUntil = 0;
  private deathPulseUntil = 0;
  private spawnPulseUntil = 0;
  /**
   * A mouse target is stored in screen coordinates, not world coordinates.
   * The camera follows the local BLOB, so a world point captured only once
   * becomes stale as soon as the camera moves and makes steering appear to
   * randomly stop. Reprojecting this point every frame keeps the target at
   * the cursor while the server remains the only authority for movement.
   */
  private mouseScreenPosition: ScreenPosition | undefined;
  private mouseIntentExpiresAt = 0;
  /** The mobile DOM joystick owns this flag; the canvas never owns touch movement. */
  private externalTouchInputActive = false;
  private worldWidth = 0;
  private worldHeight = 0;
  private readonly renderedPlayerPositions = new Map<string, RenderedPlayerPosition>();
  private readonly playerNameLabels = new Map<string, Phaser.GameObjects.Text>();

  constructor(
    private readonly room: Room,
    private readonly onUiState: (state: ArenaUiState) => void,
  ) {
    super("blob-arena");
  }

  /**
   * Receives only normalized movement intent from the DOM joystick. The
   * authoritative server still validates and applies this input.
   */
  setTouchIntent(x: number, y: number): void {
    this.externalTouchInputActive = true;
    this.mouseScreenPosition = undefined;
    this.mouseIntentExpiresAt = 0;
    this.setNormalizedIntent(x, y);
    this.sendIntent();
  }

  clearTouchIntent(): void {
    this.externalTouchInputActive = false;
    this.intent = { x: 0, y: 0 };
    this.mouseIntentExpiresAt = 0;
    this.sendIntent(true);
  }

  create(): void {
    this.graphics = this.add.graphics();
    this.game.canvas.style.touchAction = "none";
    this.cameras.main.setZoom(0.84);
    this.input.on("pointermove", this.onPointerMove, this);
    this.input.on("pointerdown", this.onPointerDown, this);
    this.input.on("gameout", this.clearPointerIntent, this);
    document.addEventListener("visibilitychange", this.clearHiddenTabIntent);
    document.addEventListener("keydown", this.preventArenaArrowScroll, { passive: false });
    const keyboardPlugin = this.input.keyboard;
    if (keyboardPlugin) {
      // `enableCapture` must remain false: the chat and profile inputs are
      // regular page controls, not game controls. Arrow scrolling is stopped
      // selectively below only while the arena owns keyboard input.
      this.keyboard = {
        wasd: createDirectionKeys(keyboardPlugin, {
          up: Phaser.Input.Keyboard.KeyCodes.W,
          down: Phaser.Input.Keyboard.KeyCodes.S,
          left: Phaser.Input.Keyboard.KeyCodes.A,
          right: Phaser.Input.Keyboard.KeyCodes.D,
        }),
        arrows: createDirectionKeys(keyboardPlugin, {
          up: Phaser.Input.Keyboard.KeyCodes.UP,
          down: Phaser.Input.Keyboard.KeyCodes.DOWN,
          left: Phaser.Input.Keyboard.KeyCodes.LEFT,
          right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        }),
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
      this.input.off("gameout", this.clearPointerIntent, this);
      document.removeEventListener("visibilitychange", this.clearHiddenTabIntent);
      document.removeEventListener("keydown", this.preventArenaArrowScroll);
      this.sendIntentEvent?.remove();
      for (const label of this.playerNameLabels.values()) {
        label.destroy();
      }
      this.playerNameLabels.clear();
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
        } else if (!this.externalTouchInputActive && !this.isTextEntryFocused()) {
          if (this.hasFreshMouseIntent()) {
            this.applyMouseIntent();
          } else {
            this.stopMouseSteering();
          }
        } else if (this.isTextEntryFocused()) {
          this.stopMouseSteering();
        }
      } else {
        this.stopMouseSteering();
      }
      // Flush changed intent from the render loop as well as pointer events,
      // while sendIntent keeps traffic under the server's rate limit.
      this.sendIntent();
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
      return;
    }
    this.blurTextEntryIfFocused();
    this.updateMouseIntent(pointer);
    this.sendIntent();
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (!pointer.wasTouch) {
      this.updateMouseIntent(pointer);
      // Do not wait for the periodic heartbeat before the first directional
      // update. This is the critical path for responsive mouse steering.
      this.sendIntent();
    }
  }

  private clearPointerIntent(): void {
    if (!this.externalTouchInputActive && !this.hasKeyboardInput()) {
      this.stopMouseSteering();
    }
  }

  private clearHiddenTabIntent(): void {
    if (document.hidden) {
      this.externalTouchInputActive = false;
      this.stopMouseSteering();
    }
  }

  private updateMouseIntent(pointer: Phaser.Input.Pointer): void {
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer?.alive) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    this.mouseScreenPosition = { x: pointer.x, y: pointer.y };
    this.mouseIntentExpiresAt = performance.now() + MOUSE_INTENT_HOLD_MS;
    this.applyMouseIntent();
  }

  private hasFreshMouseIntent(now = performance.now()): boolean {
    return this.mouseScreenPosition !== undefined && now < this.mouseIntentExpiresAt;
  }

  private stopMouseSteering(): void {
    const wasMoving = Math.abs(this.intent.x) > INPUT_CHANGE_EPSILON
      || Math.abs(this.intent.y) > INPUT_CHANGE_EPSILON
      || Math.abs(this.lastSentIntent.x) > INPUT_CHANGE_EPSILON
      || Math.abs(this.lastSentIntent.y) > INPUT_CHANGE_EPSILON;
    this.intent = { x: 0, y: 0 };
    this.mouseScreenPosition = undefined;
    this.mouseIntentExpiresAt = 0;
    if (wasMoving) {
      this.sendIntent(true);
    }
  }

  private applyMouseIntent(): void {
    const localPlayer = this.getLocalPlayer();
    if (!localPlayer?.alive || !this.mouseScreenPosition) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    const mouseTarget = this.cameras.main.getWorldPoint(
      this.mouseScreenPosition.x,
      this.mouseScreenPosition.y,
    );
    const renderedPlayer = this.getRenderedPosition(localPlayer);
    const deltaX = mouseTarget.x - renderedPlayer.x;
    const deltaY = mouseTarget.y - renderedPlayer.y;
    if (Math.hypot(deltaX, deltaY) <= MOUSE_TARGET_STOP_DISTANCE) {
      this.intent = { x: 0, y: 0 };
      return;
    }
    this.setIntentFromDelta(deltaX, deltaY);
  }

  private setIntentFromDelta(deltaX: number, deltaY: number): void {
    this.setNormalizedIntent(deltaX, deltaY, 4);
  }

  private setNormalizedIntent(x: number, y: number, deadZone = 0.01): void {
    const magnitude = Math.hypot(x, y);
    this.intent = Number.isFinite(magnitude) && magnitude > deadZone
      ? { x: x / magnitude, y: y / magnitude }
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
    this.mouseScreenPosition = undefined;
    this.setIntentFromDelta(x, y);
  }

  private hasKeyboardInput(): boolean {
    if (!this.isKeyboardControlEnabled()) {
      return false;
    }
    return this.isDirectionPressed("up") || this.isDirectionPressed("down") || this.isDirectionPressed("left") || this.isDirectionPressed("right");
  }

  private isDirectionPressed(direction: keyof DirectionKeys): boolean {
    return this.keyboard?.wasd[direction].isDown === true || this.keyboard?.arrows[direction].isDown === true;
  }

  private isKeyboardControlEnabled(): boolean {
    return !document.hidden && !this.isTextEntryFocused();
  }

  private isTextEntryFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
      || (active instanceof HTMLElement && active.isContentEditable);
  }

  private blurTextEntryIfFocused(): void {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement
      || (active instanceof HTMLElement && active.isContentEditable)) {
      active.blur();
    }
  }

  private preventArenaArrowScroll = (event: KeyboardEvent): void => {
    if (this.isKeyboardControlEnabled() && isArenaControlKey(event.code)) {
      event.preventDefault();
    }
  };

  /**
   * Sends intent without allowing a high-frequency browser event stream to
   * become an input-abuse event on the server. A forced call is only used for
   * an explicit release, which game-core intentionally accepts immediately.
   */
  private sendIntent(force = false): void {
    const state = this.room.state as unknown as NetworkArenaState | undefined;
    const localPlayer = state?.players?.get(this.room.sessionId);
    const activeIntent = state?.phase === "ACTIVE" && localPlayer?.alive ? this.intent : { x: 0, y: 0 };
    const now = performance.now();
    const changed = Math.abs(activeIntent.x - this.lastSentIntent.x) > INPUT_CHANGE_EPSILON
      || Math.abs(activeIntent.y - this.lastSentIntent.y) > INPUT_CHANGE_EPSILON;
    const elapsed = now - this.lastIntentSentAt;
    const isExplicitStop = Math.abs(activeIntent.x) <= INPUT_CHANGE_EPSILON
      && Math.abs(activeIntent.y) <= INPUT_CHANGE_EPSILON
      && (Math.abs(this.lastSentIntent.x) > INPUT_CHANGE_EPSILON
        || Math.abs(this.lastSentIntent.y) > INPUT_CHANGE_EPSILON);

    if (!force && !isExplicitStop && elapsed < INPUT_SEND_INTERVAL_MS) {
      return;
    }
    const hasContinuousControl = this.externalTouchInputActive
      || this.hasKeyboardInput()
      || this.hasFreshMouseIntent(now);
    if (!force && !changed && (!hasContinuousControl || elapsed < INPUT_HEARTBEAT_INTERVAL_MS)) {
      return;
    }
    this.room.send("input", activeIntent);
    this.lastSentIntent = { ...activeIntent };
    this.lastIntentSentAt = now;
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
      if (player.id === this.room.sessionId && (!previous || !previous.alive) && player.alive) {
        this.spawnPulseUntil = this.time.now + 460;
      }
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
      // The local player uses a shorter presentation buffer than opponents.
      // It remains entirely server-driven, but removes the extra visual lag
      // between an accepted intent and the local BLOB moving on screen.
      const playerInterpolationAlpha = player.id === this.room.sessionId
        ? Math.min(1, interpolationAlpha * 1.45)
        : interpolationAlpha;
      previous.x = Phaser.Math.Linear(previous.x, previous.targetX, playerInterpolationAlpha);
      previous.y = Phaser.Math.Linear(previous.y, previous.targetY, playerInterpolationAlpha);
    });
    for (const playerId of this.renderedPlayerPositions.keys()) {
      if (!presentPlayerIds.has(playerId)) {
        this.renderedPlayerPositions.delete(playerId);
        this.playerNameLabels.get(playerId)?.destroy();
        this.playerNameLabels.delete(playerId);
      }
    }
  }

  private getRenderedPosition(player: NetworkPlayer): ScreenPosition {
    const rendered = this.renderedPlayerPositions.get(player.id);
    return rendered ? { x: rendered.x, y: rendered.y } : { x: player.x, y: player.y };
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
      if (time < this.spawnPulseUntil) {
        this.graphics.lineStyle(3, 0x21c7a8, (this.spawnPulseUntil - time) / 460);
        this.graphics.strokeCircle(x, y + wobble, radius + 10 + (this.spawnPulseUntil - time) / 36);
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
      this.playerNameLabels.get(player.id)?.setVisible(false);
      return;
    }
    this.graphics.fillStyle(0x260719, 1);
    this.graphics.fillCircle(x - radius * 0.22, y - radius * 0.02 + wobble, Math.max(3, radius * 0.1));
    this.graphics.fillCircle(x + radius * 0.22, y - radius * 0.02 + wobble, Math.max(3, radius * 0.1));
    this.graphics.fillStyle(0xfff7f2, 0.78);
    this.graphics.fillCircle(x - radius * 0.25, y - radius * 0.07 + wobble, Math.max(1.2, radius * 0.033));
    this.graphics.fillCircle(x + radius * 0.19, y - radius * 0.07 + wobble, Math.max(1.2, radius * 0.033));
    this.updatePlayerNameLabel(player, isLocalPlayer, x, y + wobble - radius - 10);
  }

  private updatePlayerNameLabel(player: NetworkPlayer, isLocalPlayer: boolean, x: number, y: number): void {
    let label = this.playerNameLabels.get(player.id);
    if (!label) {
      label = this.add.text(0, 0, "", {
        color: "#fff7f2",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        fontStyle: "bold",
        stroke: "#160717",
        strokeThickness: 4,
      }).setOrigin(0.5, 1).setDepth(4);
      this.playerNameLabels.set(player.id, label);
    }
    label.setText(player.isBot ? "BOT · " + player.name : player.name);
    label.setColor(isLocalPlayer ? "#ffd34f" : "#fff7f2");
    label.setPosition(x, y).setVisible(player.alive);
  }

}

interface ScreenPosition {
  x: number;
  y: number;
}

function createDirectionKeys(
  keyboard: Phaser.Input.Keyboard.KeyboardPlugin,
  keyCodes: Record<"up" | "down" | "left" | "right", number>,
): DirectionKeys {
  return {
    up: keyboard.addKey(keyCodes.up, false),
    down: keyboard.addKey(keyCodes.down, false),
    left: keyboard.addKey(keyCodes.left, false),
    right: keyboard.addKey(keyCodes.right, false),
  };
}

function isArenaControlKey(code: string): boolean {
  return code === "KeyW" || code === "KeyA" || code === "KeyS" || code === "KeyD"
    || code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight";
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
