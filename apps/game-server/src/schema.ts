import { MapSchema, Schema, type } from "@colyseus/schema";
import { ArenaPhase } from "@blob/protocol";

export class BlobPlayerState extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") mass = 0;
  @type("number") score = 0;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") rank = 0;
  @type("boolean") alive = false;
  @type("number") spawnProtectedUntil = 0;
}

export class FoodState extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") mass = 0;
}

export class BlobArenaState extends Schema {
  @type({ map: BlobPlayerState }) players = new MapSchema<BlobPlayerState>();
  @type({ map: FoodState }) food = new MapSchema<FoodState>();
  @type("string") phase: string = ArenaPhase.LOBBY;
  @type("number") matchNumber = 1;
  @type("number") remainingMs = 0;
}
