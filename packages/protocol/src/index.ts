export const ARENA_ROOM_NAME = "blob_arena" as const;

export const ArenaPhase = {
  LOBBY: "LOBBY",
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  RESULTS: "RESULTS"
} as const;

export type ArenaPhase = (typeof ArenaPhase)[keyof typeof ArenaPhase];

export const ClientMessage = {
  INPUT: "input"
} as const;

export interface MovementIntent {
  x: number;
  y: number;
}

export interface PlayerJoinOptions {
  name: string;
}

export interface ArenaPlayerView {
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

export interface FoodView {
  id: string;
  x: number;
  y: number;
  mass: number;
}

export interface ArenaSnapshot {
  phase: ArenaPhase;
  matchNumber: number;
  remainingMs: number;
  players: ArenaPlayerView[];
  food: FoodView[];
  leaderboard: ArenaPlayerView[];
}
