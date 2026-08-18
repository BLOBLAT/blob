import { createGameServer } from "./server.js";

const configuredPort = Number.parseInt(process.env.PORT ?? "2567", 10);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
  ? configuredPort
  : 2567;
const server = createGameServer();

server.listen(port, "0.0.0.0")
  .then((boundPort) => {
    console.log(`[BLOB game server] listening on port ${boundPort}`);
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
