import { ArenaSimulation, DEFAULT_ARENA_CONFIG, type ArenaConfig } from "@blob/game-core";
import { ARENA_ROOM_NAME, ClientMessage, ServerEvent } from "@blob/protocol";
import { movementIntentSchema, playerJoinOptionsSchema, type ValidatedPlayerJoinOptions } from "@blob/validation";
import { MapSchema, Schema } from "@colyseus/schema";
import { type Client, Room } from "@colyseus/core";
import {
  BlobArenaState,
  BlobPlayerState,
  FinalRankingState,
  FoodState,
  LeaderboardEntryState,
} from "./schema.js";
import type { LiveMetrics } from "./liveMetrics.js";
import { ArenaChat } from "./arenaChat.js";
import { ProfileTicketVerifier, type ResolvedPlayerIdentity } from "./profileIdentity.js";

export interface BlobArenaRoomOptions {
  arenaConfig?: Partial<ArenaConfig>;
  liveMetrics?: LiveMetrics;
  profileTicketPublicKey?: string;
}

interface AuthenticatedPlayerJoinOptions extends ValidatedPlayerJoinOptions {
  identity: ResolvedPlayerIdentity;
}

export class BlobArenaRoom extends Room<{ state: BlobArenaState }> {
  override maxClients = DEFAULT_ARENA_CONFIG.maxPlayers;
  private simulation!: ArenaSimulation;
  private liveMetrics: LiveMetrics | undefined;
  private profileTicketVerifier!: ProfileTicketVerifier;
  private readonly arenaChat = new ArenaChat();

  override onCreate(options: BlobArenaRoomOptions = {}): void {
    this.liveMetrics = options.liveMetrics;
    this.profileTicketVerifier = ProfileTicketVerifier.fromBase58(options.profileTicketPublicKey ?? process.env.BLOB_PROFILE_TICKET_PUBLIC_KEY);
    this.setState(new BlobArenaState());
    this.simulation = new ArenaSimulation(options.arenaConfig);
    this.maxClients = this.simulation.config.maxPlayers;
    this.setPatchRate(this.simulation.config.tickMs);
    this.setSimulationInterval(() => {
      this.simulation.advance(Date.now());
      this.syncState();
    }, this.simulation.config.tickMs);
    this.onMessage(ClientMessage.INPUT, (client, payload: unknown) => {
      const parsed = movementIntentSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      this.simulation.setInput(client.sessionId, parsed.data, Date.now());
    });
    this.onMessage(ClientMessage.CHAT_SEND, (client, payload: unknown) => {
      this.receiveChatMessage(client, payload);
    });
  }

  override async onAuth(client: Client, options: unknown): Promise<AuthenticatedPlayerJoinOptions> {
    const parsed = playerJoinOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new Error("Invalid player join options.");
    }
    return { ...parsed.data, identity: await this.profileTicketVerifier.resolve(client.sessionId, parsed.data) };
  }

  override onJoin(client: Client, _options: unknown, auth: AuthenticatedPlayerJoinOptions): void {
    this.simulation.addPlayer(client.sessionId, auth.identity.name, Date.now());
    this.liveMetrics?.recordArenaJoin(client.sessionId);
    for (const message of this.arenaChat.getHistory()) {
      client.send(ServerEvent.CHAT_MESSAGE, message);
    }
    this.log("player_joined", {
      playerId: client.sessionId,
      profileUserId: auth.identity.profileUserId ?? null,
      name: auth.identity.name
    });
    this.syncState();
  }

  override onLeave(client: Client): void {
    this.simulation.removePlayer(client.sessionId);
    this.arenaChat.removeSender(client.sessionId);
    this.liveMetrics?.recordArenaLeave(client.sessionId);
    this.log("player_disconnected", { playerId: client.sessionId });
    this.syncState();
  }

  private receiveChatMessage(client: Client, payload: unknown): void {
    const player = this.simulation.snapshot().players.find((candidate) => candidate.id === client.sessionId);
    if (!player) {
      client.send(ServerEvent.CHAT_REJECTED, { code: "CHAT_INVALID" });
      return;
    }
    const result = this.arenaChat.send({
      playerId: client.sessionId,
      name: player.name,
      payload,
      now: Date.now()
    });
    if ("rejected" in result) {
      client.send(ServerEvent.CHAT_REJECTED, result.rejected);
      if (result.rejected.code !== "CHAT_INVALID") {
        this.log("chat_rejected", { playerId: client.sessionId, code: result.rejected.code });
      }
      return;
    }
    this.broadcast(ServerEvent.CHAT_MESSAGE, result.message);
    this.log("chat_message", { playerId: client.sessionId, messageId: result.message.id });
  }

  private syncState(): void {
    const snapshot = this.simulation.snapshot();
    syncCollection(this.state.players, snapshot.players, (player) => {
      const state = new BlobPlayerState();
      state.id = player.id;
      state.name = player.name;
      return state;
    }, (state, player) => {
      state.isBot = player.isBot;
      state.x = player.x;
      state.y = player.y;
      state.mass = player.mass;
      state.score = player.score;
      state.kills = player.kills;
      state.deaths = player.deaths;
      state.foodCollected = player.foodCollected;
      state.survivalTimeMs = player.survivalTimeMs;
      state.rank = player.rank;
      state.alive = player.alive;
      state.inRound = player.inRound;
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
      state.radius = pellet.radius;
    });
    syncCollection(this.state.leaderboard, snapshot.leaderboard, (entry) => {
      const state = new LeaderboardEntryState();
      state.playerId = entry.playerId;
      return state;
    }, (state, entry) => {
      state.name = entry.name;
      state.isBot = entry.isBot;
      state.rank = entry.rank;
      state.mass = entry.mass;
      state.kills = entry.kills;
    }, (entry) => entry.playerId);

    this.state.phase = snapshot.phase;
    this.state.mode = snapshot.mode;
    this.state.matchNumber = snapshot.matchNumber;
    this.state.matchId = snapshot.matchId;
    this.state.roundId = snapshot.roundId;
    this.state.serverTime = snapshot.serverTime;
    this.state.remainingMs = snapshot.remainingMs;
    this.state.humanPlayerCount = snapshot.humanPlayerCount;
    this.state.botPlayerCount = snapshot.botPlayerCount;
    this.state.matchmakingPlayerCount = snapshot.matchmakingPlayerCount;
    this.state.worldWidth = snapshot.world.width;
    this.state.worldHeight = snapshot.world.height;
    this.state.foodTarget = snapshot.world.foodTarget;

    const result = snapshot.result;
    this.state.result.available = result !== null;
    this.state.result.matchId = result?.matchId ?? "";
    this.state.result.roundId = result?.roundId ?? "";
    this.state.result.mode = result?.mode ?? snapshot.mode;
    this.state.result.finalizedAt = result?.finalizedAt ?? 0;
    syncCollection(this.state.result.rankings, result?.rankings ?? [], (ranking) => {
      const state = new FinalRankingState();
      state.playerId = ranking.playerId;
      return state;
    }, (state, ranking) => {
      state.name = ranking.name;
      state.isBot = ranking.isBot;
      state.rank = ranking.rank;
      state.finalMass = ranking.finalMass;
      state.foodCollected = ranking.foodCollected;
      state.eliminations = ranking.eliminations;
      state.deaths = ranking.deaths;
      state.survivalTimeMs = ranking.survivalTimeMs;
    }, (ranking) => ranking.playerId);

    for (const event of this.simulation.drainEvents()) {
      this.broadcast(event.type, event);
      if (event.type !== ServerEvent.FOOD_EATEN) {
        this.log(event.type.toLowerCase(), event);
      }
    }
  }

  private log(event: string, details: object): void {
    console.info(JSON.stringify({
      service: "blob-game-server",
      event,
      roomId: this.roomId,
      ...details,
    }));
  }
}

function syncCollection<TState extends Schema, TView>(
  collection: MapSchema<TState>,
  entries: readonly TView[],
  create: (entry: TView) => TState,
  update: (state: TState, entry: TView) => void,
  key: (entry: TView) => string = (entry) => (entry as { id: string }).id,
): void {
  const activeIds = new Set(entries.map(key));
  for (const id of collection.keys()) {
    if (!activeIds.has(id)) {
      collection.delete(id);
    }
  }
  for (const entry of entries) {
    const entryId = key(entry);
    let state = collection.get(entryId);
    if (!state) {
      state = create(entry);
      collection.set(entryId, state);
    }
    update(state, entry);
  }
}

export { ARENA_ROOM_NAME };
