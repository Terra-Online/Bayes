import { z } from "zod";

import { publicBindingSchema } from "./binding";

export const agreeSchema = z
  .object({
    serverId: z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]).optional(),
    roleId: z.string().trim().min(1).max(128).optional(),
  })
  .optional();

export const positionQuerySchema = z.object({
  socket_ticket: z.enum(["1"]).optional(),
  binding: z.enum(["1", "true"]).optional(),
  includeBinding: z.enum(["1", "true"]).optional(),
});
export const positionStreamQuerySchema = z.object({
  ticket: z.string().optional(),
  binding: z.enum(["1", "true"]).optional(),
  includeBinding: z.enum(["1", "true"]).optional(),
});
export const positionDataSchema = z.object({
  pos: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  levelId: z.string(),
  isOnline: z.boolean(),
  mapId: z.string(),
});
export const positionResponseSchema = z.object({
  data: positionDataSchema,
  socketTicket: z.string().optional(),
  binding: publicBindingSchema.optional(),
});
export const policyResponseSchema = z.object({ ok: z.literal(true), binding: publicBindingSchema });
