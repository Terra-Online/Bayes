import { z } from "zod";

export const contributionQuerySchema = z.object({
  kind: z.enum(["image", "comment"]).optional(),
  status: z.enum(["pending_openai", "pending_audit", "active", "flagged", "stale"]).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
