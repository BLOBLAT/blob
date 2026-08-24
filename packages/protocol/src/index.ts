export const ARENA_ROOM_NAME = "blob_arena" as const;

export const GameMode = {
  FREE: "FREE",
  PAID: "PAID"
} as const;

export type GameMode = (typeof GameMode)[keyof typeof GameMode];

export const ArenaPhase = {
  WAITING: "WAITING",
  MATCHMAKING: "MATCHMAKING",
  COUNTDOWN: "COUNTDOWN",
  ACTIVE: "ACTIVE",
  FINISHED: "FINISHED",
  RESULTS: "RESULTS"
} as const;

export type ArenaPhase = (typeof ArenaPhase)[keyof typeof ArenaPhase];

export const ClientMessage = {
  INPUT: "input",
  CHAT_SEND: "chat_send"
} as const;

export const ServerEvent = {
  PLAYER_JOINED: "PLAYER_JOINED",
  PLAYER_DIED: "PLAYER_DIED",
  FOOD_EATEN: "FOOD_EATEN",
  PLAYER_ELIMINATED: "PLAYER_ELIMINATED",
  ROUND_STARTED: "ROUND_STARTED",
  ROUND_FINISHED: "ROUND_FINISHED",
  MATCH_FINALIZED: "MATCH_FINALIZED",
  CHAT_MESSAGE: "CHAT_MESSAGE",
  CHAT_REJECTED: "CHAT_REJECTED"
} as const;

export type ServerEvent = (typeof ServerEvent)[keyof typeof ServerEvent];

export interface MovementIntent {
  x: number;
  y: number;
}

export interface PlayerJoinOptions {
  name: string;
  /**
   * An optional, short-lived profile assertion signed by the platform API.
   * The game server verifies it before accepting a profile display name.
   */
  profileTicket?: string;
}

export interface ArenaChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  sentAt: number;
}

export interface ArenaChatRejectedEvent {
  code: "CHAT_INVALID" | "CHAT_LINKS_NOT_ALLOWED" | "CHAT_RATE_LIMITED" | "CHAT_DUPLICATE";
}

export interface ArenaPlayerView {
  id: string;
  name: string;
  /**
   * Free Mode training participants are server-owned and always disclosed to
   * the browser. Paid matches never admit bots.
   */
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

export interface FoodView {
  id: string;
  x: number;
  y: number;
  mass: number;
  radius: number;
}

export interface ArenaWorldView {
  width: number;
  height: number;
  foodTarget: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  isBot: boolean;
  rank: number;
  mass: number;
  kills: number;
}

export interface FinalPlayerResultView {
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

export interface ArenaRoundResultView {
  matchId: string;
  roundId: string;
  mode: GameMode;
  finalizedAt: number;
  rankings: readonly FinalPlayerResultView[];
}

export interface ArenaSnapshot {
  phase: ArenaPhase;
  mode: GameMode;
  matchNumber: number;
  matchId: string;
  roundId: string;
  serverTime: number;
  remainingMs: number;
  /** Connected human participants, never synthetic arena bots. */
  humanPlayerCount: number;
  /** Clearly disclosed server-controlled Free Mode bots. */
  botPlayerCount: number;
  matchmakingPlayerCount: number;
  world: ArenaWorldView;
  players: ArenaPlayerView[];
  food: FoodView[];
  leaderboard: LeaderboardEntry[];
  result: ArenaRoundResultView | null;
}
