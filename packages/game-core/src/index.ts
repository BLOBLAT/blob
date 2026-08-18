import { ArenaPhase, type ArenaPhase as ArenaPhaseValue, type ArenaPlayerView, type ArenaSnapshot, type FoodView, type MovementIntent } from "@blob/protocol";

export { ArenaPhase } from "@blob/protocol";

export interface ArenaConfig {
  width: number;
  height: number;
  tickMs: number;
  maxPlayers: number;
  minPlayersToStart: number;
  countdownMs: number;
  matchDurationMs: number;
  resultsDurationMs: number;
  startingMass: number;
  foodCount: number;
  foodMass: number;
  foodRadius: number;
  baseMoveSpeed: number;
  minMassRatioToEat: number;
  absorbedMassBps: number;
  respawnMs: number;
  spawnProtectionMs: number;
  inputRateLimitMs: number;
  inputTimeoutMs: number;
}

export const DEFAULT_ARENA_CONFIG: ArenaConfig = {
  width: 2_400,
  height: 1_400,
  tickMs: 50,
  maxPlayers: 20,
  minPlayersToStart: 1,
  countdownMs: 3_000,
  matchDurationMs: 300_000,
  resultsDurationMs: 8_000,
  startingMass: 100,
  foodCount: 140,
  foodMass: 3,
  foodRadius: 7,
  baseMoveSpeed: 260,
  minMassRatioToEat: 1.25,
  absorbedMassBps: 7_500,
  respawnMs: 3_000,
  spawnProtectionMs: 1_500,
  inputRateLimitMs: 20,
  inputTimeoutMs: 750
};

export interface SimulatedPlayer extends ArenaPlayerView {
  input: MovementIntent;
  lastInputAt: number;
  respawnAt: number | null;
}

export interface SimulatedFood extends FoodView {}

export function createArenaConfig(overrides: Partial<ArenaConfig> = {}): ArenaConfig {
  const config = { ...DEFAULT_ARENA_CONFIG, ...overrides };

  if (config.width <= 0 || config.height <= 0 || config.tickMs <= 0) {
    throw new RangeError("Arena dimensions and tick duration must be positive.");
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < 1) {
    throw new RangeError("maxPlayers must be a positive integer.");
  }
  if (!Number.isInteger(config.minPlayersToStart) || config.minPlayersToStart < 1 || config.minPlayersToStart > config.maxPlayers) {
    throw new RangeError("minPlayersToStart must be between 1 and maxPlayers.");
  }
  if (config.absorbedMassBps < 1 || config.absorbedMassBps > 10_000) {
    throw new RangeError("absorbedMassBps must be between 1 and 10000.");
  }
  if (config.minMassRatioToEat <= 1) {
    throw new RangeError("minMassRatioToEat must be greater than one.");
  }

  return config;
}

export function playerRadius(mass: number): number {
  return Math.max(16, Math.sqrt(Math.max(0, mass)) * 5);
}

export function normalizeIntent(input: MovementIntent): MovementIntent {
  const magnitude = Math.hypot(input.x, input.y);
  if (magnitude === 0) {
    return { x: 0, y: 0 };
  }

  return magnitude > 1
    ? { x: input.x / magnitude, y: input.y / magnitude }
    : { x: input.x, y: input.y };
}

export function canPlayerEat(eater: Pick<SimulatedPlayer, "alive" | "mass" | "x" | "y" | "spawnProtectedUntil">, victim: Pick<SimulatedPlayer, "alive" | "mass" | "x" | "y" | "spawnProtectedUntil">, now: number, config: Pick<ArenaConfig, "minMassRatioToEat">): boolean {
  if (!eater.alive || !victim.alive || now < eater.spawnProtectedUntil || now < victim.spawnProtectedUntil) {
    return false;
  }
  if (eater.mass < victim.mass * config.minMassRatioToEat) {
    return false;
  }

  const distance = Math.hypot(eater.x - victim.x, eater.y - victim.y);
  return distance <= playerRadius(eater.mass) - playerRadius(victim.mass) * 0.25;
}

export class ArenaSimulation {
  readonly config: ArenaConfig;
  private readonly players = new Map<string, SimulatedPlayer>();
  private readonly food = new Map<string, SimulatedFood>();
  private phase: ArenaPhaseValue = ArenaPhase.LOBBY;
  private phaseEndsAt: number | null = null;
  private matchStartedAt: number | null = null;
  private matchNumber = 1;
  private nextSpawnSlot = 0;
  private nextFoodSequence = 0;
  private lastServerTime: number;

  constructor(config: Partial<ArenaConfig> = {}, now = Date.now()) {
    this.config = createArenaConfig(config);
    this.lastServerTime = now;
    this.fillFood();
  }

  addPlayer(id: string, name: string, now = this.lastServerTime): void {
    if (this.players.has(id)) {
      throw new Error("A player with this session id already exists.");
    }
    if (this.players.size >= this.config.maxPlayers) {
      throw new Error("The arena is full.");
    }

    const position = this.nextSpawnPosition();
    this.players.set(id, {
      id,
      name,
      ...position,
      mass: this.config.startingMass,
      score: 0,
      kills: 0,
      deaths: 0,
      rank: this.players.size + 1,
      alive: true,
      spawnProtectedUntil: now + this.config.spawnProtectionMs,
      input: { x: 0, y: 0 },
      lastInputAt: Number.NEGATIVE_INFINITY,
      respawnAt: null
    });
    this.updateRanks();
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.updateRanks();
  }

  setInput(id: string, input: MovementIntent, now: number): boolean {
    const player = this.players.get(id);
    if (!player || !player.alive || now < player.lastInputAt || now - player.lastInputAt < this.config.inputRateLimitMs) {
      return false;
    }

    player.input = normalizeIntent(input);
    player.lastInputAt = now;
    return true;
  }

  advance(now: number): void {
    if (now < this.lastServerTime) {
      return;
    }
    this.lastServerTime = now;

    switch (this.phase) {
      case ArenaPhase.LOBBY:
        if (this.players.size >= this.config.minPlayersToStart) {
          this.beginCountdown(now);
        }
        break;
      case ArenaPhase.COUNTDOWN:
        if (this.players.size < this.config.minPlayersToStart) {
          this.phase = ArenaPhase.LOBBY;
          this.phaseEndsAt = null;
        } else if (this.hasPhaseElapsed(now)) {
          this.beginMatch(now);
        }
        break;
      case ArenaPhase.PLAYING:
        this.respawnEligiblePlayers(now);
        this.applyMovement(now);
        this.collectFood();
        this.resolvePlayerCollisions(now);
        this.updateRanks();
        if (this.matchStartedAt !== null && now - this.matchStartedAt >= this.config.matchDurationMs) {
          this.phase = ArenaPhase.RESULTS;
          this.phaseEndsAt = now + this.config.resultsDurationMs;
        }
        break;
      case ArenaPhase.RESULTS:
        if (this.hasPhaseElapsed(now)) {
          this.resetMatch(now);
        }
        break;
    }
  }

  snapshot(now = this.lastServerTime): ArenaSnapshot {
    const players = [...this.players.values()].map(({ input: _input, lastInputAt: _lastInputAt, respawnAt: _respawnAt, ...player }) => ({ ...player }));
    const leaderboard = [...players].sort(comparePlayers);
    return {
      phase: this.phase,
      matchNumber: this.matchNumber,
      remainingMs: this.phaseEndsAt === null ? 0 : Math.max(0, this.phaseEndsAt - now),
      players,
      food: [...this.food.values()].map((pellet) => ({ ...pellet })),
      leaderboard
    };
  }

  private beginCountdown(now: number): void {
    this.phase = ArenaPhase.COUNTDOWN;
    this.phaseEndsAt = now + this.config.countdownMs;
  }

  private beginMatch(now: number): void {
    this.phase = ArenaPhase.PLAYING;
    this.matchStartedAt = now;
    this.phaseEndsAt = now + this.config.matchDurationMs;
  }

  private resetMatch(now: number): void {
    this.matchNumber += 1;
    this.phase = ArenaPhase.LOBBY;
    this.phaseEndsAt = null;
    this.matchStartedAt = null;
    this.nextSpawnSlot = 0;
    this.food.clear();
    this.fillFood();

    for (const player of this.players.values()) {
      const position = this.nextSpawnPosition();
      player.x = position.x;
      player.y = position.y;
      player.mass = this.config.startingMass;
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.rank = 0;
      player.alive = true;
      player.respawnAt = null;
      player.spawnProtectedUntil = now + this.config.spawnProtectionMs;
      player.input = { x: 0, y: 0 };
      player.lastInputAt = Number.NEGATIVE_INFINITY;
    }
    this.updateRanks();
  }

  private applyMovement(now: number): void {
    const stepSeconds = this.config.tickMs / 1_000;
    const margin = 8;

    for (const player of this.players.values()) {
      if (!player.alive) {
        continue;
      }
      if (now - player.lastInputAt > this.config.inputTimeoutMs) {
        player.input = { x: 0, y: 0 };
      }
      const speed = this.config.baseMoveSpeed / Math.pow(Math.max(1, player.mass / this.config.startingMass), 0.18);
      player.x = clamp(player.x + player.input.x * speed * stepSeconds, margin, this.config.width - margin);
      player.y = clamp(player.y + player.input.y * speed * stepSeconds, margin, this.config.height - margin);
    }
  }

  private collectFood(): void {
    let collectedFood = 0;
    for (const player of this.players.values()) {
      if (!player.alive) {
        continue;
      }
      for (const pellet of [...this.food.values()]) {
        if (Math.hypot(player.x - pellet.x, player.y - pellet.y) <= playerRadius(player.mass) + this.config.foodRadius) {
          this.food.delete(pellet.id);
          player.mass += pellet.mass;
          player.score += pellet.mass;
          collectedFood += 1;
        }
      }
    }
    if (collectedFood > 0) {
      this.fillFood();
    }
  }

  private resolvePlayerCollisions(now: number): void {
    const orderedPlayers = [...this.players.values()].sort((left, right) => right.mass - left.mass || left.id.localeCompare(right.id));
    for (const eater of orderedPlayers) {
      if (!eater.alive) {
        continue;
      }
      for (const victim of orderedPlayers) {
        if (eater.id === victim.id || !victim.alive || !canPlayerEat(eater, victim, now, this.config)) {
          continue;
        }
        eater.mass += Math.max(1, Math.floor((victim.mass * this.config.absorbedMassBps) / 10_000));
        eater.score += victim.mass;
        eater.kills += 1;
        victim.alive = false;
        victim.mass = 0;
        victim.deaths += 1;
        victim.input = { x: 0, y: 0 };
        victim.respawnAt = now + this.config.respawnMs;
      }
    }
  }

  private respawnEligiblePlayers(now: number): void {
    for (const player of this.players.values()) {
      if (player.alive || player.respawnAt === null || now < player.respawnAt) {
        continue;
      }
      const position = this.nextSpawnPosition();
      player.x = position.x;
      player.y = position.y;
      player.mass = this.config.startingMass;
      player.alive = true;
      player.respawnAt = null;
      player.spawnProtectedUntil = now + this.config.spawnProtectionMs;
      player.lastInputAt = Number.NEGATIVE_INFINITY;
    }
  }

  private fillFood(): void {
    while (this.food.size < this.config.foodCount) {
      const pellet = this.nextFood();
      this.food.set(pellet.id, pellet);
    }
  }

  private nextFood(): SimulatedFood {
    const sequence = this.nextFoodSequence++;
    const columns = 23;
    const rows = 13;
    const margin = Math.min(90, this.config.width * 0.08, this.config.height * 0.12);
    const column = (sequence * 17) % columns;
    const row = (Math.floor(sequence / columns) * 7 + sequence) % rows;
    return {
      id: `food-${sequence}`,
      x: margin + (column / (columns - 1)) * (this.config.width - margin * 2),
      y: margin + (row / (rows - 1)) * (this.config.height - margin * 2),
      mass: this.config.foodMass
    };
  }

  private nextSpawnPosition(): Pick<SimulatedPlayer, "x" | "y"> {
    const slots = 12;
    const angle = (this.nextSpawnSlot++ % slots) * (Math.PI * 2 / slots);
    const radius = Math.min(this.config.width, this.config.height) * 0.26;
    return {
      x: this.config.width / 2 + Math.cos(angle) * radius,
      y: this.config.height / 2 + Math.sin(angle) * radius
    };
  }

  private hasPhaseElapsed(now: number): boolean {
    return this.phaseEndsAt !== null && now >= this.phaseEndsAt;
  }

  private updateRanks(): void {
    [...this.players.values()].sort(comparePlayers).forEach((player, index) => {
      player.rank = index + 1;
    });
  }
}

function comparePlayers(left: ArenaPlayerView, right: ArenaPlayerView): number {
  return Number(right.alive) - Number(left.alive)
    || right.mass - left.mass
    || right.kills - left.kills
    || right.score - left.score
    || left.id.localeCompare(right.id);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
