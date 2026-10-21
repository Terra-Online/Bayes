import { z } from "zod";

export const agreeSchema = z
  .object({
    serverId: z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]).optional(),
    roleId: z.string().trim().min(1).max(128).optional(),
  })
  .optional();
