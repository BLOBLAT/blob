import { createGameServer } from "./server.js";

const configuredPort = Number.parseInt(process.env.BLOB_GAME_PORT ?? "2567", 10);
const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 2567;
const server = createGameServer();

server.listen(port)
  .then((boundPort) => {
    console.log(`[BLOB game server] listening on http://127.0.0.1:${boundPort}`);
  })
  .catch((error: unknown) => {
    console.error("[BLOB game server] failed to start", error);
    process.exitCode = 1;
  });

async function shutdown(): Promise<void> {
  await server.shutdown();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
