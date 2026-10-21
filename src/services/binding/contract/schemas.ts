import { z } from "zod";

import { parseEndfieldDeviceProfile } from "@/lib/endfieldClient/deviceProfile";

export const providerSchema = z.enum(["skland", "skport"]);

export const roleOptionSchema = z.object({
  serverId: z.number().int().positive(),
  roleId: z.string(),
  nickname: z.string(),
  level: z.number(),
  serverType: z.string(),
  serverName: z.string(),
  isDefault: z.boolean(),
});

export const pendingSessionSchema = z.object({
  provider: providerSchema,
  deviceProfile: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .transform((value) => {
      if (!value) {
        return undefined;
      }
      return (
        parseEndfieldDeviceProfile(typeof value === "string" ? value : JSON.stringify(value)) ??
        undefined
      );
    }),
  cred: z.string(),
  token: z.string(),
  accountToken: z.string().optional(),
  roles: z.array(roleOptionSchema),
  createdAt: z.number(),
});
