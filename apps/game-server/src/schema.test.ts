import { Encoder } from "@colyseus/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARENA_STATE_ENCODER_BUFFER_BYTES } from "./server.js";
import { BlobArenaState, BlobPlayerState, FinalRankingState, FoodState, LeaderboardEntryState } from "./schema.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("arena state transport capacity", () => {
  it("encodes the maximum configured Free Mode state without a buffer overflow", () => {
    const state = new BlobArenaState();
    state.matchNumber = 1;
    state.matchId = "free-match-max";
    state.roundId = "round-max";
    state.worldWidth = 7_200;
    state.worldHeight = 4_480;
    state.foodTarget = 2_240;
    state.humanPlayerCount = 27;
    state.botPlayerCount = 5;
    state.matchmakingPlayerCount = 32;

    for (let index = 0; index < 32; index += 1) {
      const player = new BlobPlayerState();
      player.id = "participant-" + index;
      player.name = index < 27 ? "BLOB-" + index : "ARENA " + index;
      player.isBot = index >= 27;
      player.x = 100 + index * 20;
      player.y = 200 + index * 20;
      player.mass = 100 + index;
      player.score = index;
      player.rank = index + 1;
      player.alive = true;
      player.inRound = true;
      state.players.set(player.id, player);

      if (index < 8) {
        const entry = new LeaderboardEntryState();
        entry.playerId = player.id;
        entry.name = player.name;
        entry.isBot = player.isBot;
        entry.rank = player.rank;
        entry.mass = player.mass;
        state.leaderboard.set(entry.playerId, entry);
      }

      const ranking = new FinalRankingState();
      ranking.playerId = player.id;
      ranking.name = player.name;
      ranking.isBot = player.isBot;
      ranking.rank = player.rank;
      ranking.finalMass = player.mass;
      state.result.rankings.set(ranking.playerId, ranking);
    }

    for (let index = 0; index < 2_240; index += 1) {
      const food = new FoodState();
      food.id = "food-1-" + index;
      food.x = (index * 17) % state.worldWidth;
      food.y = (index * 31) % state.worldHeight;
      food.mass = 3;
      food.radius = 7;
      state.food.set(food.id, food);
    }

    expect(Encoder.BUFFER_SIZE).toBeGreaterThanOrEqual(ARENA_STATE_ENCODER_BUFFER_BYTES);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    new Encoder(state).encodeAll();
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("buffer overflow"));
  });
});
