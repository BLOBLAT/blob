import type { Room } from "@colyseus/sdk";
import Phaser from "phaser";
import {
  directionTowardPoint,
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
const RENDER_TELEPORT_DISTANCE = 260;
const MOUSE_TARGET_STOP_DISTANCE = 8;

interface RenderedPlayerPosition {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  motionX: number;
  motionY: number;
  alive: boolean;
}

type BlobMood = "CALM" | "HUNT" | "PANIC";

interface PlayerRenderSnapshot {
  player: NetworkPlayer;
  position: ScreenPosition;
  motion: ScreenPosition;
}

interface BlobContourPoint {
  x: number;
  y: number;
}

interface BlobExpression {
  mood: BlobMood;
  lookAngle?: number;
  pullAngle?: number;
  pullStrength: number;
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
    this.setNormalizedIntent(x, y);
    this.sendIntent();
  }

  clearTouchIntent(): void {
    this.externalTouchInputActive = false;
    this.intent = { x: 0, y: 0 };
    this.sendIntent(true);
  }

  create(): void {
    this.graphics = this.add.graphics();
    this.game.canvas.style.touchAction = "none";
    this.cameras.main.setZoom(0.84);
    this.input.on("pointermove", this.onPointerMove, this);
    this.input.on("pointerdown", this.onPointerDown, this);
    // `gameout` fires as soon as a desktop cursor reaches the canvas edge.
    // It is not a deliberate stop command: retaining the last in-canvas
    // target lets a BLOB reliably travel all the way to an arena boundary.
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
          if (this.hasActiveMouseTarget()) {
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
    this.applyMouseIntent();
  }

  private hasActiveMouseTarget(): boolean {
    return this.mouseScreenPosition !== undefined;
  }

  private stopMouseSteering(): void {
    const wasMoving = Math.abs(this.intent.x) > INPUT_CHANGE_EPSILON
      || Math.abs(this.intent.y) > INPUT_CHANGE_EPSILON
      || Math.abs(this.lastSentIntent.x) > INPUT_CHANGE_EPSILON
      || Math.abs(this.lastSentIntent.y) > INPUT_CHANGE_EPSILON;
    this.intent = { x: 0, y: 0 };
    this.mouseScreenPosition = undefined;
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
    this.intent = directionTowardPoint(localPlayer, mouseTarget, MOUSE_TARGET_STOP_DISTANCE);
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
      || this.hasActiveMouseTarget();
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
          motionX: 0,
          motionY: 0,
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
      const oldX = previous.x;
      const oldY = previous.y;
      previous.x = Phaser.Math.Linear(previous.x, previous.targetX, playerInterpolationAlpha);
      previous.y = Phaser.Math.Linear(previous.y, previous.targetY, playerInterpolationAlpha);
      // Use smoothed rendered displacement for purely visual deformation.
      // Reading target - rendered position here makes faces and contours jump
      // every time Colyseus publishes a patch, despite smooth body movement.
      const frameScale = Math.max(0.5, delta / (1_000 / 60));
      previous.motionX = Phaser.Math.Linear(previous.motionX, (previous.x - oldX) / frameScale, 0.24);
      previous.motionY = Phaser.Math.Linear(previous.motionY, (previous.y - oldY) / frameScale, 0.24);
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
    const playerSnapshots: PlayerRenderSnapshot[] = [];
    state.players.forEach((player) => {
      const position = this.getRenderedPosition(player);
      playerSnapshots.push({
        player,
        position,
        motion: this.getRenderedMotion(player),
      });
    });
    for (const snapshot of playerSnapshots) {
      this.drawPlayer(
        snapshot.player,
        snapshot.player.id === localPlayerId,
        state.serverTime,
        time,
        snapshot.position,
        snapshot.motion,
        playerSnapshots,
        width,
        height,
      );
    }
  }

  private drawPlayer(
    player: NetworkPlayer,
    isLocalPlayer: boolean,
    serverTime: number,
    time: number,
    position: ScreenPosition,
    motion: ScreenPosition,
    players: PlayerRenderSnapshot[],
    worldWidth: number,
    worldHeight: number,
  ): void {
    const { x, y } = position;
    const radius = Math.max(18, Math.sqrt(Math.max(0, player.mass)) * 3.2);
    const color = colorForPlayer(player.id);
    // Do not include position in the animation phase: a moving BLOB would
    // otherwise visibly jump whenever its server-owned position changes.
    const wobble = player.alive
      ? Math.sin(time / 240 + stableHash(player.id) * 0.017) * Math.min(0.9, radius * 0.01)
      : 0;
    const expression = this.getBlobExpression(player, position, players, radius);
    const contour = this.getBlobContour(player, position, radius, time, motion, expression, worldWidth, worldHeight);
    this.graphics.fillStyle(0x000000, 0.18);
    this.graphics.fillEllipse(x + 5, y + radius * 0.3, radius * 2.04, radius * 1.58);
    this.graphics.beginPath();
    this.graphics.moveTo(contour[0]?.x ?? x, (contour[0]?.y ?? y) + wobble);
    for (let index = 1; index < contour.length; index += 1) {
      const point = contour[index];
      if (point) {
        this.graphics.lineTo(point.x, point.y + wobble);
      }
    }
    this.graphics.closePath();
    this.graphics.fillStyle(color, player.alive ? 1 : 0.2);
    this.graphics.fillPath();
    this.graphics.lineStyle(Math.max(1.5, radius * 0.035), darkenColor(color, 0.42), player.alive ? 0.86 : 0.2);
    this.graphics.strokePath();
    this.graphics.fillStyle(0xffffff, 0.16);
    this.graphics.fillEllipse(x - radius * 0.27, y - radius * 0.28 + wobble, radius * 0.34, radius * 0.46);
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
    this.drawBlobFace(x, y + wobble, radius, expression, time, player.id);
    this.updatePlayerNameLabel(player, isLocalPlayer, x, y + wobble - radius - 10);
  }

  private getRenderedMotion(player: NetworkPlayer): ScreenPosition {
    const rendered = this.renderedPlayerPositions.get(player.id);
    if (!rendered) {
      return { x: 0, y: 0 };
    }
    return {
      x: rendered.motionX,
      y: rendered.motionY,
    };
  }

  /**
   * Faces are a local presentation cue only. The same server-owned masses and
   * positions that are already rendered determine whether a BLOB is relaxed,
   * hunting prey, or alarmed by a nearby larger opponent.
   */
  private getBlobExpression(
    player: NetworkPlayer,
    position: ScreenPosition,
    players: PlayerRenderSnapshot[],
    radius: number,
  ): BlobExpression {
    let nearestThreat: { angle: number; strength: number } | undefined;
    let nearestPrey: { angle: number; strength: number } | undefined;

    for (const candidate of players) {
      const other = candidate.player;
      if (other.id === player.id || !other.alive || !other.inRound) {
        continue;
      }
      const offsetX = candidate.position.x - position.x;
      const offsetY = candidate.position.y - position.y;
      const distance = Math.hypot(offsetX, offsetY);
      if (distance <= 0) {
        continue;
      }
      const angle = Math.atan2(offsetY, offsetX);
      const perceptionRange = Math.max(280, radius * 5.5);
      if (distance > perceptionRange) {
        continue;
      }
      const closeness = Phaser.Math.Clamp(1 - distance / perceptionRange, 0, 1);
      if (other.mass >= player.mass * 1.2) {
        const strength = closeness * Phaser.Math.Clamp(other.mass / Math.max(1, player.mass) - 1, 0.2, 1.3);
        if (!nearestThreat || strength > nearestThreat.strength) {
          nearestThreat = { angle, strength };
        }
      } else if (player.mass >= other.mass * 1.25) {
        const strength = closeness * Phaser.Math.Clamp(player.mass / Math.max(1, other.mass) - 1, 0.15, 1.2);
        if (!nearestPrey || strength > nearestPrey.strength) {
          nearestPrey = { angle, strength };
        }
      }
    }

    if (nearestThreat && nearestThreat.strength >= 0.08) {
      return {
        mood: "PANIC",
        lookAngle: nearestThreat.angle,
        pullAngle: nearestThreat.angle,
        pullStrength: Phaser.Math.Clamp(nearestThreat.strength * 0.75, 0, 0.24),
      };
    }
    if (nearestPrey && nearestPrey.strength >= 0.08) {
      return {
        mood: "HUNT",
        lookAngle: nearestPrey.angle,
        pullStrength: 0,
      };
    }
    return { mood: "CALM", pullStrength: 0 };
  }

  private getBlobContour(
    player: NetworkPlayer,
    position: ScreenPosition,
    radius: number,
    time: number,
    motion: ScreenPosition,
    expression: BlobExpression,
    worldWidth: number,
    worldHeight: number,
  ): BlobContourPoint[] {
    const motionLength = Math.hypot(motion.x, motion.y);
    const motionAngle = motionLength > 0.6 ? Math.atan2(motion.y, motion.x) : Math.PI / 2;
    const motionStretch = Phaser.Math.Clamp(motionLength / Math.max(18, radius * 0.45), 0, 0.11);
    const edgeZone = Math.max(12, radius * 0.46);
    const left = Phaser.Math.Clamp(1 - (position.x - radius) / edgeZone, 0, 1);
    const right = Phaser.Math.Clamp(1 - (worldWidth - (position.x + radius)) / edgeZone, 0, 1);
    const top = Phaser.Math.Clamp(1 - (position.y - radius) / edgeZone, 0, 1);
    const bottom = Phaser.Math.Clamp(1 - (worldHeight - (position.y + radius)) / edgeZone, 0, 1);
    const normalX = right - left;
    const normalY = bottom - top;
    const wallPressure = Phaser.Math.Clamp(Math.hypot(normalX, normalY), 0, 1);
    const wallAngle = wallPressure > 0.01 ? Math.atan2(normalY, normalX) : 0;
    const identityPhase = stableHash(player.id) % 628;
    const points: BlobContourPoint[] = [];
    // More points remove the faceted look without creating enough geometry to
    // matter for a small arena roster.
    const segments = 52;
    for (let index = 0; index < segments; index += 1) {
      const angle = (Math.PI * 2 * index) / segments;
      const travelAlignment = Math.cos(angle - motionAngle);
      const wallAlignment = Math.cos(angle - wallAngle);
      const pullAlignment = expression.pullAngle === undefined ? 0 : Math.max(0, Math.cos(angle - expression.pullAngle));
      const livingWobble = player.alive
        ? Math.sin(time / 190 + identityPhase + index * 1.71) * radius * 0.007
          + Math.sin(time / 370 + identityPhase * 0.3 + index * 2.13) * radius * 0.005
        : 0;
      const travelScale = 1 + motionStretch * (travelAlignment * travelAlignment * 2 - 0.65);
      const wallScale = 1 - wallPressure * 0.18 * (wallAlignment * wallAlignment)
        + wallPressure * 0.075 * (1 - wallAlignment * wallAlignment);
      const pullScale = 1 + expression.pullStrength * pullAlignment;
      const contourRadius = Math.max(radius * 0.72, (radius + livingWobble) * travelScale * wallScale * pullScale);
      points.push({
        x: position.x + Math.cos(angle) * contourRadius,
        y: position.y + Math.sin(angle) * contourRadius,
      });
    }
    return points;
  }

  private drawBlobFace(x: number, y: number, radius: number, expression: BlobExpression, time: number, id: string): void {
    // Keep facial features upright in screen space. Rotating axis-aligned
    // ellipses around a changing movement vector is what previously detached
    // eyes, teeth and brows from each other on network updates.
    const faceX = x;
    const faceY = y;
    const eyeSpread = radius * 0.22;
    const eyeWidth = Math.max(6, radius * (expression.mood === "PANIC" ? 0.19 : 0.16));
    const eyeHeight = Math.max(6, radius * (expression.mood === "PANIC" ? 0.22 : 0.17));
    const blink = ((time + stableHash(id) * 13) % 3_900) < 115;
    const lookMagnitude = Math.max(2.2, radius * 0.045);
    const lookX = expression.lookAngle === undefined ? 0 : Math.cos(expression.lookAngle) * lookMagnitude;
    const lookY = expression.lookAngle === undefined ? 0 : Math.sin(expression.lookAngle) * lookMagnitude;
    const leftEye = {
      x: faceX - eyeSpread,
      y: faceY - radius * 0.12,
    };
    const rightEye = {
      x: faceX + eyeSpread,
      y: faceY - radius * 0.12,
    };
    this.graphics.fillStyle(0xfff7f2, 0.94);
    if (blink) {
      this.graphics.lineStyle(Math.max(2, radius * 0.045), 0x260719, 0.9);
      this.graphics.lineBetween(leftEye.x - eyeWidth * 0.32, leftEye.y, leftEye.x + eyeWidth * 0.32, leftEye.y);
      this.graphics.lineBetween(rightEye.x - eyeWidth * 0.32, rightEye.y, rightEye.x + eyeWidth * 0.32, rightEye.y);
    } else {
      this.graphics.fillEllipse(leftEye.x, leftEye.y, eyeWidth, eyeHeight);
      this.graphics.fillEllipse(rightEye.x, rightEye.y, eyeWidth, eyeHeight);
      const pupilRadius = Math.max(2.8, radius * 0.07);
      this.graphics.fillStyle(0x260719, 1);
      this.graphics.fillCircle(leftEye.x + lookX, leftEye.y + lookY, pupilRadius);
      this.graphics.fillCircle(rightEye.x + lookX, rightEye.y + lookY, pupilRadius);
      this.graphics.fillStyle(0xffffff, 0.7);
      this.graphics.fillCircle(leftEye.x + lookX - pupilRadius * 0.24, leftEye.y + lookY - pupilRadius * 0.24, Math.max(1, pupilRadius * 0.28));
      this.graphics.fillCircle(rightEye.x + lookX - pupilRadius * 0.24, rightEye.y + lookY - pupilRadius * 0.24, Math.max(1, pupilRadius * 0.28));
    }

    const browY = faceY - radius * 0.31;
    this.graphics.lineStyle(Math.max(1.6, radius * 0.035), 0x260719, 0.95);
    if (expression.mood === "HUNT") {
      // Angry brows stay visibly above the eyes and slope toward the nose.
      this.graphics.lineBetween(leftEye.x - eyeWidth * 0.56, browY - eyeHeight * 0.22, leftEye.x + eyeWidth * 0.48, browY + eyeHeight * 0.2);
      this.graphics.lineBetween(rightEye.x - eyeWidth * 0.48, browY + eyeHeight * 0.2, rightEye.x + eyeWidth * 0.56, browY - eyeHeight * 0.22);
    } else if (expression.mood === "PANIC") {
      this.graphics.lineBetween(leftEye.x - eyeWidth * 0.46, browY + eyeHeight * 0.16, leftEye.x + eyeWidth * 0.46, browY - eyeHeight * 0.16);
      this.graphics.lineBetween(rightEye.x - eyeWidth * 0.46, browY - eyeHeight * 0.16, rightEye.x + eyeWidth * 0.46, browY + eyeHeight * 0.16);
    } else {
      // A slight asymmetry keeps even relaxed BLOBs playfully unsettling.
      this.graphics.lineBetween(leftEye.x - eyeWidth * 0.42, browY, leftEye.x + eyeWidth * 0.42, browY - eyeHeight * 0.1);
      this.graphics.lineBetween(rightEye.x - eyeWidth * 0.4, browY - eyeHeight * 0.1, rightEye.x + eyeWidth * 0.4, browY + eyeHeight * 0.04);
    }

    const mouthX = faceX + Math.sin(time / 520 + stableHash(id) * 0.11) * radius * 0.012;
    const mouthY = faceY + radius * 0.28;
    const mouthWidth = radius * (expression.mood === "HUNT" ? 0.58 : expression.mood === "PANIC" ? 0.5 : 0.48);
    const mouthHeight = radius * (expression.mood === "PANIC" ? 0.31 : expression.mood === "HUNT" ? 0.25 : 0.2);
    this.graphics.fillStyle(0x260719, 0.98);
    this.graphics.fillEllipse(mouthX, mouthY, mouthWidth, mouthHeight);
    this.graphics.fillStyle(0xfff7f2, 0.96);
    const toothWidth = Math.max(3, mouthWidth * 0.12);
    const toothHeight = Math.max(3, mouthHeight * 0.68);
    const toothCount = expression.mood === "HUNT" ? 4 : expression.mood === "PANIC" ? 3 : 2;
    for (let index = 0; index < toothCount; index += 1) {
      const spread = (index / (toothCount - 1) - 0.5) * mouthWidth * 0.62;
      const toothX = mouthX + spread;
      const toothTop = mouthY - mouthHeight * 0.35;
      this.graphics.fillTriangle(
        toothX - toothWidth / 2,
        toothTop,
        toothX + toothWidth / 2,
        toothTop,
        toothX,
        toothTop + toothHeight,
      );
      if ((expression.mood === "HUNT" && index % 2 === 0) || (expression.mood === "PANIC" && index === 1)) {
        const toothBottom = mouthY + mouthHeight * 0.34;
        this.graphics.fillTriangle(
          toothX - toothWidth * 0.4,
          toothBottom,
          toothX + toothWidth * 0.4,
          toothBottom,
          toothX,
          toothBottom - toothHeight * 0.68,
        );
      }
    }
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
  const palette = [
    0xf42b68,
    0x8e6bff,
    0x21c7a8,
    0xff9d3d,
    0x42a5f5,
    0xd86df6,
    0xff6fae,
    0x63d8ee,
    0xc7ef4d,
    0xff715f,
    0x6c78f7,
    0x00c9a7,
  ];
  return palette[stableHash(id) % palette.length] ?? 0xf42b68;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function darkenColor(color: number, amount: number): number {
  const factor = Phaser.Math.Clamp(1 - amount, 0, 1);
  const red = Math.round(((color >> 16) & 0xff) * factor);
  const green = Math.round(((color >> 8) & 0xff) * factor);
  const blue = Math.round((color & 0xff) * factor);
  return (red << 16) | (green << 8) | blue;
}
