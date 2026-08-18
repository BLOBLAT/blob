import { MapSchema, Schema, type } from "@colyseus/schema";
import { ArenaPhase, GameMode } from "@blob/protocol";

export class BlobPlayerState extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") mass = 0;
  @type("number") score = 0;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") foodCollected = 0;
  @type("number") survivalTimeMs = 0;
  @type("number") rank = 0;
  @type("boolean") alive = false;
  @type("boolean") inRound = false;
  @type("number") spawnProtectedUntil = 0;
}

export class FoodState extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") mass = 0;
  @type("number") radius = 0;
}

export class LeaderboardEntryState extends Schema {
  @type("string") playerId = "";
  @type("string") name = "";
  @type("number") rank = 0;
  @type("number") mass = 0;
  @type("number") kills = 0;
}

export class FinalRankingState extends Schema {
  @type("string") playerId = "";
  @type("string") name = "";
  @type("number") rank = 0;
  @type("number") finalMass = 0;
  @type("number") foodCollected = 0;
  @type("number") eliminations = 0;
  @type("number") deaths = 0;
  @type("number") survivalTimeMs = 0;
}

export class RoundResultState extends Schema {
  @type("boolean") available = false;
  @type("string") matchId = "";
  @type("string") roundId = "";
  @type("string") mode: string = GameMode.FREE;
  @type("number") finalizedAt = 0;
  @type({ map: FinalRankingState }) rankings = new MapSchema<FinalRankingState>();
}

export class BlobArenaState extends Schema {
  @type({ map: BlobPlayerState }) players = new MapSchema<BlobPlayerState>();
  @type({ map: FoodState }) food = new MapSchema<FoodState>();
  @type({ map: LeaderboardEntryState }) leaderboard = new MapSchema<LeaderboardEntryState>();
  @type(RoundResultState) result = new RoundResultState();
  @type("string") phase: string = ArenaPhase.WAITING;
  @type("string") mode: string = GameMode.FREE;
  @type("number") matchNumber = 0;
  @type("string") matchId = "";
  @type("string") roundId = "";
  @type("number") serverTime = 0;
  @type("number") remainingMs = 0;
  @type("number") matchmakingPlayerCount = 0;
  @type("number") worldWidth = 0;
  @type("number") worldHeight = 0;
  @type("number") foodTarget = 0;
}
