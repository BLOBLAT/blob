import { z } from "zod";

export const playerJoinOptionsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(16)
      .regex(/^[A-Za-z0-9 _-]+$/, "Name contains unsupported characters")
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
