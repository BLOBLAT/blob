import { z } from "zod";

export const playerJoinOptionsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(16)
      .regex(/^[A-Za-z0-9 _-]+$/, "Name contains unsupported characters"),
    profileTicket: z.string().min(32).max(1_024).optional()
  })
  .strict();

export const movementIntentSchema = z
  .object({
    x: z.number().finite().min(-1).max(1),
    y: z.number().finite().min(-1).max(1)
  })
  .strict();

export type ValidatedPlayerJoinOptions = z.infer<typeof playerJoinOptionsSchema>;
export type ValidatedMovementIntent = z.infer<typeof movementIntentSchema>;

const forbiddenLinkPattern = /(?:https?|hxxps?)\s*:\s*\/\/|\bwww\s*(?:\.|\[\.\])|\b(?:[a-z0-9-]+\s*(?:\.|\[\.\])\s*)+(?:com|net|org|io|gg|app|dev|xyz|info|me|ru|lat|sol|click|link|site|online|co|tv|ai)\b/i;

export type ChatMessageRejectionCode = "CHAT_INVALID" | "CHAT_LINKS_NOT_ALLOWED";

export type ValidatedChatMessage = {
  text: string;
};

/**
 * Normalizes plain chat text once at the network boundary. URLs, including
 * common obfuscated dot forms, are rejected before a room can retain or relay
 * them. Renderers must still use textContent, never HTML.
 */
export function validateChatMessage(payload: unknown):
  | { success: true; data: ValidatedChatMessage }
  | { success: false; code: ChatMessageRejectionCode } {
  const parsed = z.object({ text: z.string().max(1_024) }).strict().safeParse(payload);
  if (!parsed.success) {
    return { success: false, code: "CHAT_INVALID" };
  }
  const text = parsed.data.text
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 1 || text.length > 240) {
    return { success: false, code: "CHAT_INVALID" };
  }
  if (forbiddenLinkPattern.test(text)) {
    return { success: false, code: "CHAT_LINKS_NOT_ALLOWED" };
  }
  return { success: true, data: { text } };
}
