import { type ArenaChatMessage, type ArenaChatRejectedEvent } from "@blob/protocol";
import { validateChatMessage } from "@blob/validation";
import { randomUUID } from "node:crypto";

const MAX_HISTORY = 80;
const MIN_MESSAGE_INTERVAL_MS = 1_250;
const RATE_WINDOW_MS = 20_000;
const MAX_MESSAGES_PER_WINDOW = 8;
const DUPLICATE_WINDOW_MS = 12_000;
const SENDER_STATE_RETENTION_MS = Math.max(RATE_WINDOW_MS, DUPLICATE_WINDOW_MS) + 5_000;

interface SenderWindow {
  sentAt: number[];
  lastText?: string;
  lastTextAt?: number;
  lastSeenAt: number;
}

export class ArenaChat {
  private readonly history: ArenaChatMessage[] = [];
  private readonly senderWindows = new Map<string, SenderWindow>();

  /**
   * Validates and reserves a chat send. Callers must persist the resulting
   * message before calling `commit`; this keeps a durable audit record ahead
   * of every message broadcast to other players.
   */
  prepare(input: { playerId: string; senderKey?: string; name: string; payload: unknown; now: number }):
    | { message: ArenaChatMessage }
    | { rejected: ArenaChatRejectedEvent } {
    const parsed = validateChatMessage(input.payload);
    if (!parsed.success) {
      return { rejected: { code: parsed.code } };
    }
    this.pruneSenderWindows(input.now);
    const senderKey = input.senderKey ?? input.playerId;
    const window = this.senderWindows.get(senderKey) ?? { sentAt: [], lastSeenAt: input.now };
    window.sentAt = window.sentAt.filter((sentAt) => input.now - sentAt < RATE_WINDOW_MS);
    window.lastSeenAt = input.now;
    if (
      (window.sentAt.length > 0 && input.now - window.sentAt[window.sentAt.length - 1]! < MIN_MESSAGE_INTERVAL_MS)
      || window.sentAt.length >= MAX_MESSAGES_PER_WINDOW
    ) {
      this.senderWindows.set(senderKey, window);
      return { rejected: { code: "CHAT_RATE_LIMITED" } };
    }
    if (window.lastText === parsed.data.text && window.lastTextAt !== undefined && input.now - window.lastTextAt < DUPLICATE_WINDOW_MS) {
      this.senderWindows.set(senderKey, window);
      return { rejected: { code: "CHAT_DUPLICATE" } };
    }
    window.sentAt.push(input.now);
    window.lastText = parsed.data.text;
    window.lastTextAt = input.now;
    this.senderWindows.set(senderKey, window);
    const message: ArenaChatMessage = {
      id: randomUUID(),
      playerId: input.playerId,
      name: input.name,
      text: parsed.data.text,
      sentAt: input.now
    };
    return { message };
  }

  commit(message: ArenaChatMessage): void {
    this.history.push(message);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  getHistory(): readonly ArenaChatMessage[] {
    return this.history;
  }

  removeSender(playerId: string): void {
    this.senderWindows.delete(playerId);
  }

  private pruneSenderWindows(now: number): void {
    for (const [senderKey, window] of this.senderWindows) {
      if (now - window.lastSeenAt > SENDER_STATE_RETENTION_MS) {
        this.senderWindows.delete(senderKey);
      }
    }
  }
}
