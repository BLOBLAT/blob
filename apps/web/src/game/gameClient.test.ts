import { describe, expect, it } from "vitest";
import { createGameClient } from "./gameClient.js";

describe("createGameClient", () => {
  it("uses credential-free HTTP for cross-origin arena matchmaking", () => {
    const client = createGameClient("https://game.example.test");

    expect(client.http.options.credentials).toBe("omit");
  });
});
