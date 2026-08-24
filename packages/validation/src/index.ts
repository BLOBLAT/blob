import { z } from "zod";

export const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9 _-]{3,16}$/;

export type DisplayNameRejectionCode = "DISPLAY_NAME_INVALID" | "DISPLAY_NAME_RESERVED";

export type ValidatedDisplayName = {
  displayName: string;
  displayNameKey: string;
};

/**
 * Public names deliberately remain ASCII-only for now. This is a product
 * safety decision: it prevents visually confusable Unicode staff names until
 * a full UTS #39 identity policy is reviewed. The same canonical form is
 * used for PostgreSQL uniqueness and protected-name checks.
 */
export function normalizeDisplayName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function canonicalizeDisplayName(value: string): string {
  return normalizeDisplayName(value).toLocaleUpperCase("en-US");
}

/**
 * Collapsing separators and common ASCII digit substitutions stops obvious
 * attempts such as `BLOB-admin`, `m0d_erator`, and `SUP PORT`. It is used
 * only for reserved-name matching; the canonical database key stays readable.
 */
export function createDisplayNameSkeleton(value: string): string {
  return canonicalizeDisplayName(value)
    .replace(/[ _-]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/3/g, "E")
    .replace(/4/g, "A")
    .replace(/5/g, "S")
    .replace(/7/g, "T");
}

const RESERVED_EXACT_SKELETONS = new Set([
  "ADMIN",
  "ADMINISTRATOR",
  "MOD",
  "MODERATOR",
  "STAFF",
  "SUPPORT",
  "HELP",
  "TEAM",
  "OFFICIAL",
  "VERIFIED",
  "OWNER",
  "FOUNDER",
  "DEVELOPER",
  "DEV",
  "OPERATOR",
  "SECURITY",
  "SYSTEM",
  "SERVER",
  "BOT",
  "ARENABOT",
  "RAILWAY",
  "VERCEL",
  "CLOUDFLARE",
  "PHANTOM",
  "SOLANA",
  "USDC",
  "TREASURY",
  "ESCROW",
  "WALLET",
  "PAYMENT",
  "PAYOUT",
  "SETTLEMENT"
]);

// These long terms are rejected inside a name as well. The short values
// above stay exact so unrelated names such as "model" are not over-blocked.
const RESERVED_EMBEDDED_SKELETONS = [
  "ADMIN",
  "ADMINISTRATOR",
  "MODERATOR",
  "STAFF",
  "SUPPORT",
  "OFFICIAL",
  "VERIFIED",
  "OWNER",
  "FOUNDER",
  "DEVELOPER",
  "OPERATOR",
  "SECURITY",
  "SYSTEM",
  "SERVER",
  "TREASURY",
  "ESCROW",
  "WALLET",
  "PAYMENT",
  "PAYOUT",
  "SETTLEMENT"
];

const RESERVED_BLOB_SUFFIXES = ["ADMIN", "MOD", "MODERATOR", "STAFF", "SUPPORT", "OFFICIAL", "TEAM", "BOT"];

export function isReservedDisplayName(value: string): boolean {
  const skeleton = createDisplayNameSkeleton(value);
  if (RESERVED_EXACT_SKELETONS.has(skeleton) || skeleton.startsWith("ARENA")) {
    return true;
  }
  if (RESERVED_BLOB_SUFFIXES.some((suffix) => skeleton === "BLOB" + suffix || skeleton.startsWith("BLOB" + suffix))) {
    return true;
  }
  return RESERVED_EMBEDDED_SKELETONS.some((term) => skeleton.includes(term));
}

export function validateDisplayName(value: string):
  | { success: true; data: ValidatedDisplayName }
  | { success: false; code: DisplayNameRejectionCode } {
  const displayName = normalizeDisplayName(value);
  if (!DISPLAY_NAME_PATTERN.test(displayName)) {
    return { success: false, code: "DISPLAY_NAME_INVALID" };
  }
  if (isReservedDisplayName(displayName)) {
    return { success: false, code: "DISPLAY_NAME_RESERVED" };
  }
  return { success: true, data: { displayName, displayNameKey: canonicalizeDisplayName(displayName) } };
}

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
