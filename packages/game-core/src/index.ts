import {
  ArenaPhase,
  type ArenaPlayerView,
  type ArenaRoundResultView,
  type ArenaSnapshot,
  type FoodView,
  GameMode,
  type GameMode as GameModeType,
  type LeaderboardEntry,
  type MovementIntent,
  ServerEvent,
  type ServerEvent as ServerEventType,
} from "@blob/protocol";

export interface ArenaConfig {
  mode: GameModeType;
  width: number;
  height: number;
  maxWorldWidth: number;
  maxWorldHeight: number;
  worldSizingGrid: number;
  tickMs: number;
  minPlayersToStart: number;
  maxPlayers: number;
  matchmakingDurationMs: number;
  startWhenMinimumPlayersReached: boolean;
  countdownDurationMs: number;
  matchDurationMs: number;
  finishedDurationMs: number;
  resultsDurationMs: number;
  startingMass: number;
  foodCount: number;
  maxFoodCount: number;
  foodMass: number;
  foodRadius: number;
  baseMoveSpeed: number;
  minimumMassRatioToEat: number;
  absorbedMassPercent: number;
  respawnEnabled: boolean;
  respawnDelayMs: number;
  spawnProtectionMs: number;
  safeSpawnDistance: number;
  inputRateLimitPerSecond: number;
  inputTimeoutMs: number;
  /** Free Mode only. Bots are always marked as bots in synchronized state. */
  freeModeBotsEnabled: boolean;
  freeModeBotMinCount: number;
  freeModeBotMaxCount: number;
  botDecisionIntervalMs: number;
  botPerceptionRange: number;
  botFoodSearchRange: number;
  botMoveSpeedMultiplier: number;
}

/**
 * Paid terms are created before funding and bind their hashes to these
 * server-created identifiers. Free rounds continue to allocate IDs at their
 * authoritative countdown; a paid simulation must receive them explicitly.
 */
export interface PaidRoundIdentity {
  matchId: string;
  roundId: string;
}

export interface ArenaSimulationOptions extends Partial<ArenaConfig> {
  paidRoundIdentity?: PaidRoundIdentity;
}

/**
 * Server-side reasons for an intent the simulation did not accept. These are
 * transport-safety signals only: the browser never gets authority to repair
 * or override a rejected movement command.
 */
export const ArenaInputRejectionReason = {
  PLAYER_NOT_FOUND: "PLAYER_NOT_FOUND",
  ROUND_NOT_ACTIVE: "ROUND_NOT_ACTIVE",
  PLAYER_NOT_ALIVE: "PLAYER_NOT_ALIVE",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
  INVALID_VECTOR: "INVALID_VECTOR",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type ArenaInputRejectionReason = (typeof ArenaInputRejectionReason)[keyof typeof ArenaInputRejectionReason];

export type ArenaInputAdmission =
  | { accepted: true }
  | { accepted: false; reason: ArenaInputRejectionReason };

export const DEFAULT_ARENA_CONFIG: ArenaConfig = {
  mode: GameMode.FREE,
  width: 2200,
  height: 1360,
  maxWorldWidth: 7200,
  maxWorldHeight: 4480,
  worldSizingGrid: 40,
  tickMs: 50,
  minPlayersToStart: 2,
  maxPlayers: 32,
  matchmakingDurationMs: 120_000,
  startWhenMinimumPlayersReached: true,
  countdownDurationMs: 10_000,
  matchDurationMs: 600_000,
  finishedDurationMs: 1_000,
  resultsDurationMs: 15_000,
  startingMass: 100,
  foodCount: 140,
  maxFoodCount: 2_240,
  foodMass: 3,
  foodRadius: 7,
  baseMoveSpeed: 260,
  minimumMassRatioToEat: 1.25,
  absorbedMassPercent: 0.75,
  respawnEnabled: true,
  respawnDelayMs: 3_000,
  spawnProtectionMs: 1_500,
  safeSpawnDistance: 110,
  inputRateLimitPerSecond: 25,
  // Explicit stop inputs are applied immediately. This longer fallback only
  // handles a lost client/tab without making normal network jitter feel like
  // a player released their controls.
  inputTimeoutMs: 650,
  freeModeBotsEnabled: true,
  freeModeBotMinCount: 3,
  freeModeBotMaxCount: 5,
  botDecisionIntervalMs: 360,
  botPerceptionRange: 560,
  botFoodSearchRange: 500,
  botMoveSpeedMultiplier: 0.84,
};

export interface WorldSize {
  width: number;
  height: number;
}

export interface SimulationEvent {
  type: ServerEventType;
  playerId?: string;
  targetPlayerId?: string;
  matchId?: string;
  roundId?: string;
}

interface SimulationPlayer extends ArenaPlayerView {
  input: MovementIntent;
  lastInputAt: number;
  respawnAt: number | null;
  joinSequence: number;
  bot?: BotState;
}

interface SimulationFood extends FoodView {}

interface BotState {
  seed: number;
  personality: "HUNTER" | "GATHERER" | "CAUTIOUS";
  nextDecisionAt: number;
}

const ZERO_INPUT: MovementIntent = { x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToGrid(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function inputLength(input: MovementIntent): number {
  return Math.hypot(input.x, input.y);
}

function cloneInput(input: MovementIntent): MovementIntent {
  return { x: input.x, y: input.y };
}

function createId(prefix: string, sequence: number, now: number): string {
  return prefix + "-" + now.toString(36) + "-" + sequence.toString(36);
}

function assertPaidRoundIdentity(identity: PaidRoundIdentity | undefined): asserts identity is PaidRoundIdentity {
  if (!identity
    || !isInternalRoundIdentifier(identity.matchId)
    || !isInternalRoundIdentifier(identity.roundId)
    || identity.matchId === identity.roundId) {
    throw new Error("Paid Mode requires distinct server-assigned matchId and roundId values.");
  }
}

function isInternalRoundIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function deterministicInteger(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function requirePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(name + " must be a positive finite number");
  }
}

export function createArenaConfig(overrides: Partial<ArenaConfig> = {}): ArenaConfig {
  const config = { ...DEFAULT_ARENA_CONFIG, ...overrides };

  for (const [name, value] of Object.entries(config)) {
    if (typeof value === "number") {
      requirePositiveNumber(name, value);
    }
  }

  if (config.minPlayersToStart > config.maxPlayers) {
    throw new Error("minPlayersToStart cannot exceed maxPlayers");
  }
  if (config.maxWorldWidth < config.width || config.maxWorldHeight < config.height) {
    throw new Error("maximum world dimensions cannot be smaller than base dimensions");
  }
  if (config.minimumMassRatioToEat <= 1) {
    throw new Error("minimumMassRatioToEat must be greater than 1");
  }
  if (config.absorbedMassPercent > 1) {
    throw new Error("absorbedMassPercent cannot exceed 1");
  }
  if (config.freeModeBotMinCount > config.freeModeBotMaxCount) {
    throw new Error("freeModeBotMinCount cannot exceed freeModeBotMaxCount");
  }
  if (config.botMoveSpeedMultiplier > 1) {
    throw new Error("botMoveSpeedMultiplier cannot exceed 1");
  }

  return config;
}

/**
 * Selects a varied but reproducible Free Mode bot roster for a round. This
 * never runs for Paid Mode and does not depend on browser input or entropy.
 */
export function calculateFreeModeBotCount(
  nextMatchNumber: number,
  config: ArenaConfig = DEFAULT_ARENA_CONFIG,
): number {
  if (!config.freeModeBotsEnabled || config.mode !== GameMode.FREE) {
    return 0;
  }
  const range = config.freeModeBotMaxCount - config.freeModeBotMinCount + 1;
  return config.freeModeBotMinCount + deterministicInteger(nextMatchNumber * 7919 + 17) % range;
}

export function calculateWorldSize(playerCount: number, config: ArenaConfig = DEFAULT_ARENA_CONFIG): WorldSize {
  const effectivePlayers = clamp(Math.floor(playerCount), 1, config.maxPlayers);
  const baselinePlayers = Math.max(1, config.minPlayersToStart);
  const scale = Math.sqrt(Math.max(effectivePlayers, baselinePlayers) / baselinePlayers);
  if (scale <= 1) {
    return { width: config.width, height: config.height };
  }

  return {
    width: clamp(
      roundToGrid(config.width * scale, config.worldSizingGrid),
      config.width,
      config.maxWorldWidth,
    ),
    height: clamp(
      roundToGrid(config.height * scale, config.worldSizingGrid),
      config.height,
      config.maxWorldHeight,
    ),
  };
}

export function calculateFoodTarget(playerCount: number, config: ArenaConfig = DEFAULT_ARENA_CONFIG): number {
  const effectivePlayers = Math.max(config.minPlayersToStart, Math.floor(playerCount));
  const scaled = Math.round((config.foodCount * effectivePlayers) / config.minPlayersToStart);
  return clamp(scaled, config.foodCount, config.maxFoodCount);
}

export function radiusFromMass(mass: number): number {
  return Math.max(18, Math.sqrt(mass) * 3.2);
}

export class ArenaSimulation {
  readonly config: ArenaConfig;
  private readonly players = new Map<string, SimulationPlayer>();
  private readonly food = new Map<string, SimulationFood>();
  private readonly events: SimulationEvent[] = [];
  private phase: ArenaPhase = ArenaPhase.WAITING;
  private phaseEndsAt: number | null = null;
  private now = 0;
  private lastAdvanceAt: number | null = null;
  private matchNumber = 0;
  private matchId = "";
  private roundId = "";
  private result: ArenaRoundResultView | null = null;
  private world: WorldSize;
  private foodTarget = 0;
  private joinSequence = 0;
  private foodSequence = 0;
  private readonly paidRoundIdentity: PaidRoundIdentity | undefined;
  private paidRoundFinalized = false;

  constructor(options: ArenaSimulationOptions = {}) {
    const { paidRoundIdentity, ...overrides } = options;
    this.config = createArenaConfig(overrides);
    this.paidRoundIdentity = paidRoundIdentity;
    if (this.config.mode === GameMode.PAID) {
      assertPaidRoundIdentity(paidRoundIdentity);
    } else if (paidRoundIdentity) {
      throw new Error("paidRoundIdentity is only valid for Paid Mode.");
    }
    this.world = calculateWorldSize(this.config.minPlayersToStart, this.config);
  }

  addPlayer(id: string, name: string, now: number): void {
    if (this.players.has(id)) {
      return;
    }

    this.now = now;
    this.makeRoomForHumanPlayer();
    if (this.players.size >= this.config.maxPlayers) {
      return;
    }
    const player = this.createPlayer(id, name, now, false);
    this.players.set(id, player);
    if (this.phase === ArenaPhase.ACTIVE && this.config.mode === GameMode.FREE) {
      this.activatePlayerForRound(player, player.joinSequence);
    }
    this.events.push({ type: ServerEvent.PLAYER_JOINED, playerId: id });
    this.updateRanks();
  }

  removePlayer(id: string): void {
    const player = this.players.get(id);
    if (!player || player.isBot) {
      return;
    }
    this.players.delete(id);
    if (this.humanPlayerCount() === 0) {
      this.resetToWaiting();
      return;
    }
    this.updateRanks();
  }

  setInput(id: string, input: MovementIntent, now: number): boolean {
    return this.trySetInput(id, input, now).accepted;
  }

  /**
   * Common authoritative input gate for every transport. Free Mode calls it
   * from its Colyseus Room; future paid transport uses the same gate.
   */
  trySetInput(id: string, input: MovementIntent, now: number): ArenaInputAdmission {
    const player = this.players.get(id);
    if (!player || player.isBot) {
      return { accepted: false, reason: ArenaInputRejectionReason.PLAYER_NOT_FOUND };
    }
    if (this.phase !== ArenaPhase.ACTIVE) {
      return { accepted: false, reason: ArenaInputRejectionReason.ROUND_NOT_ACTIVE };
    }
    if (!player.alive) {
      return { accepted: false, reason: ArenaInputRejectionReason.PLAYER_NOT_ALIVE };
    }
    if (!Number.isFinite(now)) {
      return { accepted: false, reason: ArenaInputRejectionReason.INVALID_TIMESTAMP };
    }
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || Math.abs(input.x) > 1 || Math.abs(input.y) > 1) {
      return { accepted: false, reason: ArenaInputRejectionReason.INVALID_VECTOR };
    }
    const length = inputLength(input);
    // A release must never be stuck behind the movement rate limiter. The
    // room still has a bounded message rate, and this makes every valid zero
    // intent take effect on the next authoritative tick.
    if (length > 0 && now - player.lastInputAt < 1_000 / this.config.inputRateLimitPerSecond) {
      return { accepted: false, reason: ArenaInputRejectionReason.RATE_LIMITED };
    }

    player.input = length > 1 ? { x: input.x / length, y: input.y / length } : cloneInput(input);
    player.lastInputAt = now;
    return { accepted: true };
  }

  advance(now: number): void {
    if (!Number.isFinite(now)) {
      return;
    }
    const elapsed = this.lastAdvanceAt === null ? 0 : clamp(now - this.lastAdvanceAt, 0, this.config.tickMs * 4);
    this.now = now;
    this.lastAdvanceAt = now;

    switch (this.phase) {
      case ArenaPhase.WAITING:
        if (this.humanPlayerCount() > 0 && !this.paidRoundFinalized) {
          this.beginMatchmaking();
        }
        break;
      case ArenaPhase.MATCHMAKING:
        this.advanceMatchmaking();
        break;
      case ArenaPhase.COUNTDOWN:
        this.advanceCountdown();
        break;
      case ArenaPhase.ACTIVE:
        this.advanceActive(elapsed);
        break;
      case ArenaPhase.FINISHED:
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
          this.beginResults();
        }
        break;
      case ArenaPhase.RESULTS:
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
          this.resetToWaiting();
        }
        break;
    }
  }

  drainEvents(): SimulationEvent[] {
    return this.events.splice(0);
  }

  snapshot(): ArenaSnapshot {
    const players = [...this.players.values()]
      .sort((left, right) => left.joinSequence - right.joinSequence)
      .map((player) => this.toPlayerView(player));
    const leaderboard = this.getLeaderboard();

    return {
      phase: this.phase,
      mode: this.config.mode,
      matchNumber: this.matchNumber,
      matchId: this.matchId,
      roundId: this.roundId,
      serverTime: this.now,
      remainingMs: this.remainingMs(),
      humanPlayerCount: this.humanPlayerCount(),
      botPlayerCount: this.botPlayerCount(),
      matchmakingPlayerCount: this.eligiblePlayerCount(),
      world: {
        width: this.world.width,
        height: this.world.height,
        foodTarget: this.foodTarget,
      },
      players,
      food: [...this.food.values()].map((pellet) => ({ ...pellet })),
      leaderboard,
      result: this.result ? this.cloneResult(this.result) : null,
    };
  }

  private createPlayer(id: string, name: string, now: number, isBot: boolean, botSeed?: number): SimulationPlayer {
    const bot = isBot && botSeed !== undefined
      ? {
        seed: botSeed,
        personality: (["HUNTER", "GATHERER", "CAUTIOUS"] as const)[botSeed % 3] ?? "GATHERER",
        nextDecisionAt: now,
      }
      : undefined;
    return {
      id,
      name: name.slice(0, 24),
      isBot,
      x: this.world.width / 2,
      y: this.world.height / 2,
      mass: this.config.startingMass,
      score: 0,
      kills: 0,
      deaths: 0,
      foodCollected: 0,
      survivalTimeMs: 0,
      rank: this.players.size + 1,
      alive: false,
      inRound: false,
      spawnProtectedUntil: 0,
      input: cloneInput(ZERO_INPUT),
      lastInputAt: now,
      respawnAt: null,
      joinSequence: ++this.joinSequence,
      bot,
    };
  }

  private makeRoomForHumanPlayer(): void {
    if (this.players.size < this.config.maxPlayers) {
      return;
    }
    const bot = [...this.players.values()]
      .filter((player) => player.isBot)
      .sort((left, right) => right.joinSequence - left.joinSequence)[0];
    if (bot) {
      this.players.delete(bot.id);
    }
  }

  private ensureFreeModeBots(): void {
    if (this.config.mode !== GameMode.FREE || !this.config.freeModeBotsEnabled) {
      return;
    }
    const maximumBots = Math.max(0, this.config.maxPlayers - this.humanPlayerCount());
    const desiredBots = Math.min(
      calculateFreeModeBotCount(this.matchNumber + 1, this.config),
      maximumBots,
    );
    const bots = [...this.players.values()]
      .filter((player) => player.isBot)
      .sort((left, right) => right.joinSequence - left.joinSequence);
    for (const bot of bots.slice(desiredBots)) {
      this.players.delete(bot.id);
    }
    for (let index = this.botPlayerCount(); index < desiredBots; index += 1) {
      const seed = deterministicInteger((this.matchNumber + 1) * 997 + index * 131);
      const id = "arena-bot-" + (this.matchNumber + 1) + "-" + (index + 1);
      this.players.set(id, this.createPlayer(id, "ARENA " + (index + 1), this.now, true, seed));
    }
  }

  private removeBots(): void {
    for (const player of this.players.values()) {
      if (player.isBot) {
        this.players.delete(player.id);
      }
    }
  }

  private beginMatchmaking(): void {
    this.phase = ArenaPhase.MATCHMAKING;
    this.phaseEndsAt = this.now + this.config.matchmakingDurationMs;
    this.result = null;
    this.matchId = "";
    this.roundId = "";
    this.food.clear();
    this.foodTarget = 0;
    this.ensureFreeModeBots();
    for (const player of this.players.values()) {
      player.alive = false;
      player.inRound = false;
      player.input = cloneInput(ZERO_INPUT);
      player.respawnAt = null;
    }
  }

  private advanceMatchmaking(): void {
    if (this.humanPlayerCount() === 0) {
      this.resetToWaiting();
      return;
    }
    const eligible = this.eligiblePlayerCount();
    if (eligible === 0) {
      this.resetToWaiting();
      return;
    }
    const shouldStart = eligible >= this.config.minPlayersToStart && (
      this.config.startWhenMinimumPlayersReached ||
      eligible >= this.config.maxPlayers ||
      (this.phaseEndsAt !== null && this.now >= this.phaseEndsAt)
    );
    if (shouldStart) {
      this.beginCountdown();
    }
  }

  private advanceCountdown(): void {
    if (this.humanPlayerCount() === 0 || this.eligiblePlayerCount() < this.config.minPlayersToStart) {
      this.beginMatchmaking();
      return;
    }
    if (this.phaseEndsAt !== null && this.now >= this.phaseEndsAt) {
      this.beginActive();
    }
  }

  private beginCountdown(): void {
    this.matchNumber += 1;
    if (this.config.mode === GameMode.PAID) {
      // The constructor rejects a missing identity. Keep the assertion here
      // so a future refactor cannot silently fall back to generated paid IDs.
      assertPaidRoundIdentity(this.paidRoundIdentity);
      this.matchId = this.paidRoundIdentity.matchId;
      this.roundId = this.paidRoundIdentity.roundId;
    } else {
      this.matchId = createId(this.config.mode.toLowerCase() + "-match", this.matchNumber, this.now);
      this.roundId = createId("round", this.matchNumber, this.now);
    }
    this.world = calculateWorldSize(this.eligiblePlayerCount(), this.config);
    this.foodTarget = calculateFoodTarget(this.eligiblePlayerCount(), this.config);
    this.food.clear();
    this.foodSequence = 0;
    this.result = null;
    this.phase = ArenaPhase.COUNTDOWN;
    this.phaseEndsAt = this.now + this.config.countdownDurationMs;

    let spawnIndex = 0;
    for (const player of this.players.values()) {
      this.activatePlayerForRound(player, spawnIndex++);
    }
    this.replenishFood();
    this.updateRanks();
  }

  private activatePlayerForRound(player: SimulationPlayer, spawnSeed: number): void {
    player.inRound = true;
    player.alive = true;
    player.mass = this.config.startingMass;
    player.score = 0;
    player.kills = 0;
    player.deaths = 0;
    player.foodCollected = 0;
    player.survivalTimeMs = 0;
    player.input = cloneInput(ZERO_INPUT);
    player.lastInputAt = this.now;
    player.respawnAt = null;
    player.spawnProtectedUntil = this.now + this.config.spawnProtectionMs;
    this.placeSafely(player, spawnSeed);
  }

  private beginActive(): void {
    this.phase = ArenaPhase.ACTIVE;
    this.phaseEndsAt = this.now + this.config.matchDurationMs;
    this.events.push({ type: ServerEvent.ROUND_STARTED, matchId: this.matchId, roundId: this.roundId });
  }

  private advanceActive(elapsed: number): void {
    if (this.phaseEndsAt !== null && this.now >= this.phaseEndsAt) {
      this.finalizeRound();
      return;
    }

    for (const player of this.players.values()) {
      if (!player.inRound) {
        continue;
      }
      if (player.alive) {
        if (player.isBot) {
          this.updateBotIntent(player);
        }
        player.survivalTimeMs += elapsed;
        this.applyMovement(player, elapsed);
      } else if (this.config.respawnEnabled && player.respawnAt !== null && this.now >= player.respawnAt) {
        this.respawnPlayer(player);
      }
    }
    this.collectFood();
    this.resolvePlayerCollisions();
    this.replenishFood();
    this.updateRanks();
  }

  private beginResults(): void {
    this.phase = ArenaPhase.RESULTS;
    this.phaseEndsAt = this.now + this.config.resultsDurationMs;
  }

  private resetToWaiting(): void {
    this.phase = ArenaPhase.WAITING;
    this.phaseEndsAt = null;
    this.matchId = "";
    this.roundId = "";
    this.result = null;
    this.food.clear();
    this.foodTarget = 0;
    this.removeBots();
    for (const player of this.players.values()) {
      player.alive = false;
      player.inRound = false;
      player.input = cloneInput(ZERO_INPUT);
      player.respawnAt = null;
    }
    this.updateRanks();
  }

  private applyMovement(player: SimulationPlayer, elapsed: number): void {
    const stale = this.now - player.lastInputAt > this.config.inputTimeoutMs;
    const input = stale ? ZERO_INPUT : player.input;
    const length = inputLength(input);
    if (length === 0) {
      return;
    }

    const normalizedX = input.x / length;
    const normalizedY = input.y / length;
    const speed = this.config.baseMoveSpeed
      * Math.pow(this.config.startingMass / Math.max(player.mass, this.config.startingMass), 0.22)
      * (player.isBot ? this.config.botMoveSpeedMultiplier : 1);
    player.x += normalizedX * speed * (elapsed / 1_000);
    player.y += normalizedY * speed * (elapsed / 1_000);
    this.constrainPlayerToWorld(player);
  }

  /**
   * Server-only Free Mode bot behaviour. Bots use the same intent and
   * movement pipeline as a browser client: flee danger, pursue safe prey,
   * collect nearby food, then roam. No browser message can create or steer a
   * bot.
   */
  private updateBotIntent(player: SimulationPlayer): void {
    const bot = player.bot;
    if (!bot || this.now < bot.nextDecisionAt) {
      return;
    }
    bot.nextDecisionAt = this.now + this.config.botDecisionIntervalMs;

    const visiblePlayers = [...this.players.values()]
      .filter((other) => other.id !== player.id && other.alive && other.inRound)
      .map((other) => ({ other, distance: Math.hypot(other.x - player.x, other.y - player.y) }))
      .filter(({ distance }) => distance <= this.config.botPerceptionRange)
      .sort((left, right) => left.distance - right.distance);
    const threat = visiblePlayers.find(({ other }) => other.mass >= player.mass * 1.16);
    if (threat) {
      this.setBotDirection(player, player.x - threat.other.x, player.y - threat.other.y);
      return;
    }

    const pursuitRatio = this.config.minimumMassRatioToEat * (bot.personality === "HUNTER" ? 1 : 1.08);
    const prey = bot.personality === "CAUTIOUS"
      ? undefined
      : visiblePlayers.find(({ other }) => player.mass >= other.mass * pursuitRatio);
    if (prey) {
      this.setBotDirection(player, prey.other.x - player.x, prey.other.y - player.y);
      return;
    }

    const food = [...this.food.values()]
      .map((pellet) => ({ pellet, distance: Math.hypot(pellet.x - player.x, pellet.y - player.y) }))
      .filter(({ distance }) => distance <= this.config.botFoodSearchRange)
      .sort((left, right) => left.distance - right.distance)[0];
    if (food) {
      this.setBotDirection(player, food.pellet.x - player.x, food.pellet.y - player.y);
      return;
    }

    const decision = Math.floor(this.now / this.config.botDecisionIntervalMs);
    const x = this.seededCoordinate(bot.seed + decision * 37, this.world.width, radiusFromMass(player.mass));
    const y = this.seededCoordinate(bot.seed + decision * 61 + 19, this.world.height, radiusFromMass(player.mass));
    this.setBotDirection(player, x - player.x, y - player.y);
  }

  private setBotDirection(player: SimulationPlayer, x: number, y: number): void {
    const length = Math.hypot(x, y);
    player.input = length > 0 ? { x: x / length, y: y / length } : cloneInput(ZERO_INPUT);
    player.lastInputAt = this.now;
  }

  private collectFood(): void {
    for (const player of this.players.values()) {
      if (!player.alive || !player.inRound) {
        continue;
      }
      const radius = radiusFromMass(player.mass);
      for (const [foodId, pellet] of this.food) {
        if (Math.hypot(player.x - pellet.x, player.y - pellet.y) > radius + pellet.radius) {
          continue;
        }
        this.food.delete(foodId);
        player.mass += pellet.mass;
        player.score += pellet.mass;
        player.foodCollected += 1;
        this.constrainPlayerToWorld(player);
        this.events.push({ type: ServerEvent.FOOD_EATEN, playerId: player.id, matchId: this.matchId, roundId: this.roundId });
      }
    }
  }

  private resolvePlayerCollisions(): void {
    const activePlayers = [...this.players.values()].filter((player) => player.alive && player.inRound);
    for (let index = 0; index < activePlayers.length; index += 1) {
      const first = activePlayers[index];
      if (!first) {
        continue;
      }
      for (let otherIndex = index + 1; otherIndex < activePlayers.length; otherIndex += 1) {
        const second = activePlayers[otherIndex];
        if (!second) {
          continue;
        }
        if (!first.alive || !second.alive || first.spawnProtectedUntil > this.now || second.spawnProtectedUntil > this.now) {
          continue;
        }
        const firstCanEat = first.mass >= second.mass * this.config.minimumMassRatioToEat;
        const secondCanEat = second.mass >= first.mass * this.config.minimumMassRatioToEat;
        if (!firstCanEat && !secondCanEat) {
          continue;
        }
        const winner = firstCanEat ? first : second;
        const loser = firstCanEat ? second : first;
        if (Math.hypot(winner.x - loser.x, winner.y - loser.y) > radiusFromMass(winner.mass)) {
          continue;
        }
        winner.mass += loser.mass * this.config.absorbedMassPercent;
        winner.score += loser.mass * this.config.absorbedMassPercent;
        winner.kills += 1;
        this.constrainPlayerToWorld(winner);
        loser.deaths += 1;
        loser.alive = false;
        loser.input = cloneInput(ZERO_INPUT);
        loser.respawnAt = this.config.respawnEnabled ? this.now + this.config.respawnDelayMs : null;
        this.events.push({ type: ServerEvent.PLAYER_ELIMINATED, playerId: winner.id, targetPlayerId: loser.id, matchId: this.matchId, roundId: this.roundId });
        this.events.push({ type: ServerEvent.PLAYER_DIED, playerId: loser.id, targetPlayerId: winner.id, matchId: this.matchId, roundId: this.roundId });
      }
    }
  }

  private respawnPlayer(player: SimulationPlayer): void {
    player.alive = true;
    player.mass = this.config.startingMass;
    player.input = cloneInput(ZERO_INPUT);
    player.lastInputAt = this.now;
    player.respawnAt = null;
    if (player.bot) {
      player.bot.nextDecisionAt = this.now;
    }
    player.spawnProtectedUntil = this.now + this.config.spawnProtectionMs;
    this.placeSafely(player, player.joinSequence + this.matchNumber);
  }

  private replenishFood(): void {
    while (this.food.size < this.foodTarget) {
      const sequence = ++this.foodSequence;
      const id = "food-" + this.matchNumber + "-" + sequence;
      const x = this.seededCoordinate(sequence * 17 + 11, this.world.width, this.config.foodRadius);
      const y = this.seededCoordinate(sequence * 31 + 7, this.world.height, this.config.foodRadius);
      this.food.set(id, {
        id,
        x,
        y,
        mass: this.config.foodMass,
        radius: this.config.foodRadius,
      });
    }
  }

  private seededCoordinate(seed: number, size: number, padding: number): number {
    const value = Math.sin(seed * 12.9898 + this.matchNumber * 78.233) * 43_758.5453;
    const fraction = value - Math.floor(value);
    return padding + fraction * Math.max(1, size - padding * 2);
  }

  private placeSafely(player: SimulationPlayer, seed: number): void {
    const playerRadius = radiusFromMass(player.mass);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidateSeed = (seed + 1) * 97 + attempt * 13;
      const x = this.seededCoordinate(candidateSeed, this.world.width, playerRadius);
      const y = this.seededCoordinate(candidateSeed + 41, this.world.height, playerRadius);
      const safe = [...this.players.values()].every((other) => {
        if (other.id === player.id || !other.alive || !other.inRound) {
          return true;
        }
        const minimumDistance = this.config.safeSpawnDistance + playerRadius + radiusFromMass(other.mass);
        return Math.hypot(x - other.x, y - other.y) >= minimumDistance;
      });
      if (safe) {
        player.x = x;
        player.y = y;
        return;
      }
    }
    player.x = clamp(this.world.width / 2, playerRadius, this.world.width - playerRadius);
    player.y = clamp(this.world.height / 2, playerRadius, this.world.height - playerRadius);
  }

  private constrainPlayerToWorld(player: SimulationPlayer): void {
    const radius = radiusFromMass(player.mass);
    const horizontalPadding = Math.min(radius, this.world.width / 2);
    const verticalPadding = Math.min(radius, this.world.height / 2);
    player.x = clamp(player.x, horizontalPadding, this.world.width - horizontalPadding);
    player.y = clamp(player.y, verticalPadding, this.world.height - verticalPadding);
  }

  private finalizeRound(): void {
    const ranked = [...this.players.values()]
      .filter((player) => player.inRound)
      .sort((left, right) => this.comparePlayers(left, right))
      .map((player, index) => ({
        playerId: player.id,
        name: player.name,
        isBot: player.isBot,
        rank: index + 1,
        finalMass: player.mass,
        foodCollected: player.foodCollected,
        eliminations: player.kills,
        deaths: player.deaths,
        survivalTimeMs: player.survivalTimeMs,
      }));
    this.result = Object.freeze({
      matchId: this.matchId,
      roundId: this.roundId,
      mode: this.config.mode,
      finalizedAt: this.now,
      rankings: Object.freeze(ranked),
    });
    this.phase = ArenaPhase.FINISHED;
    if (this.config.mode === GameMode.PAID) {
      this.paidRoundFinalized = true;
    }
    this.phaseEndsAt = this.now + this.config.finishedDurationMs;
    this.updateRanks();
    this.events.push({ type: ServerEvent.ROUND_FINISHED, matchId: this.matchId, roundId: this.roundId });
    this.events.push({ type: ServerEvent.MATCH_FINALIZED, matchId: this.matchId, roundId: this.roundId });
  }

  private comparePlayers(left: SimulationPlayer, right: SimulationPlayer): number {
    if (right.mass !== left.mass) {
      return right.mass - left.mass;
    }
    if (right.survivalTimeMs !== left.survivalTimeMs) {
      return right.survivalTimeMs - left.survivalTimeMs;
    }
    if (left.joinSequence !== right.joinSequence) {
      return left.joinSequence - right.joinSequence;
    }
    return left.id.localeCompare(right.id);
  }

  private updateRanks(): void {
    const ranked = [...this.players.values()]
      .filter((player) => player.inRound)
      .sort((left, right) => this.comparePlayers(left, right));
    ranked.forEach((player, index) => {
      player.rank = index + 1;
    });
  }

  private getLeaderboard(): LeaderboardEntry[] {
    return [...this.players.values()]
      .filter((player) => player.inRound && player.alive)
      .sort((left, right) => this.comparePlayers(left, right))
      .slice(0, 8)
      .map((player) => ({
        playerId: player.id,
        name: player.name,
        isBot: player.isBot,
        rank: player.rank,
        mass: Math.round(player.mass),
        kills: player.kills,
      }));
  }

  private eligiblePlayerCount(): number {
    return this.players.size;
  }

  private humanPlayerCount(): number {
    return [...this.players.values()].filter((player) => !player.isBot).length;
  }

  private botPlayerCount(): number {
    return [...this.players.values()].filter((player) => player.isBot).length;
  }

  private remainingMs(): number {
    if (this.phaseEndsAt === null) {
      return 0;
    }
    return Math.max(0, this.phaseEndsAt - this.now);
  }

  private toPlayerView(player: SimulationPlayer): ArenaPlayerView {
    const {
      input: _input,
      lastInputAt: _lastInputAt,
      respawnAt: _respawnAt,
      joinSequence: _joinSequence,
      bot: _bot,
      ...view
    } = player;
    return { ...view };
  }

  private cloneResult(result: ArenaRoundResultView): ArenaRoundResultView {
    return {
      ...result,
      rankings: result.rankings.map((ranking) => ({ ...ranking })),
    };
  }
}
