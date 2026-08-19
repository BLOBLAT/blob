export class GameServerConfigurationError extends Error {
  constructor() {
    super("The game server is not configured for this deployment.");
  }
}

export function resolveGameServerUrl(): string {
  const configured = import.meta.env.VITE_GAME_SERVER_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (import.meta.env.DEV) {
    return "http://127.0.0.1:2567";
  }
  throw new GameServerConfigurationError();
}
