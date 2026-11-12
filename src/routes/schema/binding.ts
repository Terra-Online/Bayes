import { z } from "zod";

import { providerSchema } from "@/services/official/contract/provider";

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

export const publicBindingSchema = z
  .union([
    z.object({ bound: z.literal(false), enabled: z.literal(false) }),
    z.object({
      bound: z.literal(true),
      enabled: z.boolean(),
      provider: providerSchema,
      serverId: z.number(),
      roleId: z.string(),
      nickname: z.string(),
      serverName: z.string(),
      updatedAt: z.string(),
    }),
  ])
  .meta({ ref: "Binding" });
export const bindingResponseSchema = z.object({ binding: publicBindingSchema });
export const bindingMutationResponseSchema = bindingResponseSchema.extend({ ok: z.literal(true) });
export const bindingExchangeResponseSchema = z.object({
  flowId: z.string(),
  roles: z.array(
    z.object({
      serverId: z.number(),
      roleId: z.string(),
      nickname: z.string(),
      level: z.number(),
      serverType: z.string(),
      serverName: z.string(),
      isDefault: z.boolean(),
    }),
  ),
});
export const officialMarksResponseSchema = z.object({
  binding: publicBindingSchema,
  timestamp: z.string(),
  markedIds: z.array(z.string()),
  pointIds: z.array(z.string()),
  markers: z.array(z.object({ id: z.string(), isUserMarked: z.boolean() })),
  raw: z
    .object({
      map01: z.object({ code: z.number(), message: z.string().optional(), data: z.unknown() }),
      map02: z.object({ code: z.number(), message: z.string().optional(), data: z.unknown() }),
    })
    .describe(
      "Upstream-owned map payloads; clients should use pointIds and markers for the stable Bayes representation.",
    ),
});
