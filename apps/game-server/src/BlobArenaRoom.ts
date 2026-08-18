import { ArenaSimulation, DEFAULT_ARENA_CONFIG } from "@blob/game-core";
import { ARENA_ROOM_NAME, ClientMessage, type ArenaPlayerView } from "@blob/protocol";
import { movementIntentSchema, playerJoinOptionsSchema, type ValidatedPlayerJoinOptions } from "@blob/validation";
import { MapSchema } from "@colyseus/schema";
import { type Client, Room } from "@colyseus/core";
import { BlobArenaState, BlobPlayerState, FoodState } from "./schema.js";

export class BlobArenaRoom extends Room<{ state: BlobArenaState }> {
  override maxClients = DEFAULT_ARENA_CONFIG.maxPlayers;
  private simulation!: ArenaSimulation;

  override onCreate(): void {
    this.setState(new BlobArenaState());
    this.simulation = new ArenaSimulation();
    this.setPatchRate(DEFAULT_ARENA_CONFIG.tickMs);
    this.setSimulationInterval(() => {
      const now = Date.now();
      this.simulation.advance(now);
      this.syncState(now);
    }, DEFAULT_ARENA_CONFIG.tickMs);
    this.onMessage(ClientMessage.INPUT, (client, payload: unknown) => {
      const parsed = movementIntentSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      this.simulation.setInput(client.sessionId, parsed.data, Date.now());
    });
  }

  override onAuth(_client: Client, options: unknown): ValidatedPlayerJoinOptions {
    const parsed = playerJoinOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new Error("Invalid player join options.");
    }
    return parsed.data;
  }

  override onJoin(client: Client, _options: unknown, auth: ValidatedPlayerJoinOptions): void {
    this.simulation.addPlayer(client.sessionId, auth.name, Date.now());
    this.syncState(Date.now());
  }

  override onLeave(client: Client): void {
    this.simulation.removePlayer(client.sessionId);
    this.syncState(Date.now());
  }

  private syncState(now: number): void {
    const snapshot = this.simulation.snapshot(now);
    syncCollection(this.state.players, snapshot.players, (player) => {
      const state = new BlobPlayerState();
      state.id = player.id;
      state.name = player.name;
      return state;
    }, (state, player) => {
      state.x = player.x;
      state.y = player.y;
      state.mass = player.mass;
      state.score = player.score;
      state.kills = player.kills;
      state.deaths = player.deaths;
      state.rank = player.rank;
      state.alive = player.alive;
      state.spawnProtectedUntil = player.spawnProtectedUntil;
    });
    syncCollection(this.state.food, snapshot.food, (pellet) => {
      const state = new FoodState();
      state.id = pellet.id;
      return state;
    }, (state, pellet) => {
      state.x = pellet.x;
      state.y = pellet.y;
      state.mass = pellet.mass;
    });
    this.state.phase = snapshot.phase;
    this.state.matchNumber = snapshot.matchNumber;
    this.state.remainingMs = snapshot.remainingMs;
  }
}

function syncCollection<TState extends { id: string }, TView extends { id: string }>(
  collection: MapSchema<TState>,
  entries: readonly TView[],
  create: (entry: TView) => TState,
  update: (state: TState, entry: TView) => void
): void {
  const activeIds = new Set(entries.map((entry) => entry.id));
  for (const id of collection.keys()) {
    if (!activeIds.has(id)) {
      collection.delete(id);
    }
  }
  for (const entry of entries) {
    let state = collection.get(entry.id);
    if (!state) {
      state = create(entry);
      collection.set(entry.id, state);
    }
    update(state, entry);
  }
}

export { ARENA_ROOM_NAME };
