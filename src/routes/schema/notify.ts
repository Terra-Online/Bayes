import { z } from "zod";

export const listQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  unreadOnly: z.enum(["0", "1"]).optional(),
});

export const readManySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
});
