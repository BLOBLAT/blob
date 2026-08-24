import { describe, expect, it } from "vitest";
import { ArenaChat } from "./arenaChat.js";

describe("ArenaChat profile rate limits", () => {
  it("keeps an authenticated sender's short rate limit across a reconnect", () => {
    const chat = new ArenaChat();
    const senderKey = "profile:97df9855-2f2d-4377-8104-3b9c3d1d7a0a";
    const first = chat.prepare({
      playerId: "first-session",
      senderKey,
      name: "Blob Player",
      payload: { text: "first message" },
      now: 1_000,
    });
    expect("message" in first).toBe(true);
    chat.removeSender("first-session");

    const afterReconnect = chat.prepare({
      playerId: "second-session",
      senderKey,
      name: "Blob Player",
      payload: { text: "second message" },
      now: 1_100,
    });
    expect(afterReconnect).toEqual({ rejected: { code: "CHAT_RATE_LIMITED" } });
  });
});
