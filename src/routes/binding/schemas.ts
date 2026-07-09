import { z } from "zod";

export const providerSchema = z.enum(["skland", "skport"]);

export const exchangeTokenSchema = z.object({
  provider: providerSchema,
  token: z.string().trim().min(8).max(4096)
});

export const exchangeCodeSchema = z.object({
  provider: providerSchema,
  code: z.string().trim().min(4).max(4096)
});

export const bindRoleSchema = z.object({
  flowId: z.string().trim().min(16).max(128),
  serverId: z.number().int().positive(),
  roleId: z.string().trim().min(1).max(128)
});

export const agreeSchema = z.object({
  serverId: z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]).optional(),
  roleId: z.string().trim().min(1).max(128).optional()
}).optional();

export const roleOptionSchema = z.object({
  serverId: z.number().int().positive(),
  roleId: z.string(),
  nickname: z.string(),
  level: z.number(),
  serverType: z.string(),
  serverName: z.string(),
  isDefault: z.boolean()
});

export const pendingSessionSchema = z.object({
  provider: providerSchema,
  cred: z.string(),
  token: z.string(),
  accountToken: z.string().optional(),
  roles: z.array(roleOptionSchema),
  createdAt: z.number()
});
