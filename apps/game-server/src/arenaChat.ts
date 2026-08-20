import { type ArenaChatMessage, type ArenaChatRejectedEvent } from "@blob/protocol";
import { validateChatMessage } from "@blob/validation";

const MAX_HISTORY = 80;
const MIN_MESSAGE_INTERVAL_MS = 1_250;
const RATE_WINDOW_MS = 20_000;
const MAX_MESSAGES_PER_WINDOW = 8;
const DUPLICATE_WINDOW_MS = 12_000;

interface SenderWindow {
  sentAt: number[];
  lastText?: string;
  lastTextAt?: number;
}

export class ArenaChat {
  private readonly history: ArenaChatMessage[] = [];
  private readonly senderWindows = new Map<string, SenderWindow>();
  private sequence = 0;

  send(input: { playerId: string; name: string; payload: unknown; now: number }):
    | { message: ArenaChatMessage }
    | { rejected: ArenaChatRejectedEvent } {
    const parsed = validateChatMessage(input.payload);
    if (!parsed.success) {
      return { rejected: { code: parsed.code } };
    }
    const window = this.senderWindows.get(input.playerId) ?? { sentAt: [] };
    window.sentAt = window.sentAt.filter((sentAt) => input.now - sentAt < RATE_WINDOW_MS);
    if (
      (window.sentAt.length > 0 && input.now - window.sentAt[window.sentAt.length - 1]! < MIN_MESSAGE_INTERVAL_MS)
      || window.sentAt.length >= MAX_MESSAGES_PER_WINDOW
    ) {
      this.senderWindows.set(input.playerId, window);
      return { rejected: { code: "CHAT_RATE_LIMITED" } };
    }
    if (window.lastText === parsed.data.text && window.lastTextAt !== undefined && input.now - window.lastTextAt < DUPLICATE_WINDOW_MS) {
      this.senderWindows.set(input.playerId, window);
      return { rejected: { code: "CHAT_DUPLICATE" } };
    }
    window.sentAt.push(input.now);
    window.lastText = parsed.data.text;
    window.lastTextAt = input.now;
    this.senderWindows.set(input.playerId, window);
    const message: ArenaChatMessage = {
      id: "chat-" + (++this.sequence),
      playerId: input.playerId,
      name: input.name,
      text: parsed.data.text,
      sentAt: input.now
    };
    this.history.push(message);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    return { message };
  }

  getHistory(): readonly ArenaChatMessage[] {
    return this.history;
  }

  removeSender(playerId: string): void {
    this.senderWindows.delete(playerId);
  }
}
