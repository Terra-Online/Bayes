import { z } from "zod";

import { providerSchema } from "@/services/binding/contract/schemas";

export const exchangeTokenSchema = z.object({
  provider: providerSchema,
  token: z.string().trim().min(8).max(4096),
  deviceId: z
    .string()
    .trim()
    .regex(/^(?:B)?[A-Za-z0-9+/=_-]{20,256}$/)
    .optional(),
});

export const exchangeCodeSchema = z.object({
  provider: providerSchema,
  code: z.string().trim().min(4).max(4096),
  deviceId: z
    .string()
    .trim()
    .regex(/^(?:B)?[A-Za-z0-9+/=_-]{20,256}$/)
    .optional(),
});

export const bindRoleSchema = z.object({
  flowId: z.string().trim().min(16).max(128),
  serverId: z.number().int().positive(),
  roleId: z.string().trim().min(1).max(128),
});
