import { z } from "zod";
import { parseEndfieldDeviceProfile } from "../../lib/endfieldClient/deviceProfile";

export const providerSchema = z.enum(["skland", "skport"]);

export const exchangeTokenSchema = z.object({
  provider: providerSchema,
  token: z.string().trim().min(8).max(4096),
  deviceId: z.string().trim().regex(/^(?:B)?[A-Za-z0-9+/=_-]{20,256}$/).optional()
});

export const exchangeCodeSchema = z.object({
  provider: providerSchema,
  code: z.string().trim().min(4).max(4096),
  deviceId: z.string().trim().regex(/^(?:B)?[A-Za-z0-9+/=_-]{20,256}$/).optional()
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
  deviceProfile: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().transform((value) => {
    if (!value) return undefined;
    return parseEndfieldDeviceProfile(typeof value === "string" ? value : JSON.stringify(value)) ?? undefined;
  }),
  cred: z.string(),
  token: z.string(),
  accountToken: z.string().optional(),
  roles: z.array(roleOptionSchema),
  createdAt: z.number()
});
