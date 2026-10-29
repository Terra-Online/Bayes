import { z } from "zod";

export { managementActionSchema as updateSchema } from "@/services/moderation/contract/actions";

export const listSchema = z.object({
  submissionId: z.string().trim().min(1).max(64).optional(),
  status: z.string().max(200).optional(),
  mode: z.enum(["all", "reports"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});

export const duplicateImagesQuerySchema = z.object({
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

export const imageCoverageQuerySchema = z.object({
  scope: z.enum(["test", "prod"]).optional(),
});

export const duplicateMarkerImagesQuerySchema = z.object({
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

export const runSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const warningSchema = z.object({
  publicUid: z.string().trim().min(1).max(32),
});
