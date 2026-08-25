import { Client } from "@colyseus/sdk";

/**
 * The arena accepts anonymous, ticket-based game admission; it never uses
 * browser cookies for authentication. Colyseus defaults its HTTP helper to
 * `credentials: "include"`, which makes a cross-origin matchmaking request
 * require CORS credentials and prevents the browser from using our strict,
 * credential-free game-server policy. Keep this explicit at the boundary.
 */
export function createGameClient(gameServerUrl: string): Client {
  const client = new Client(gameServerUrl);
  client.http.options.credentials = "omit";
  return client;
}
