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

export const deletionSchema = z.object({
  expectedLifecycleVersion: z.number().int().min(0),
  note: z.string().trim().max(500).optional(),
});
export const deleteSchema = deletionSchema.extend({
  expectedSnapshotId: z.string().trim().min(1).max(64),
});

export const correctionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  expectedReviewStatus: z.enum([
    "approved",
    "rejected",
    "unknown",
    "pending_openai",
    "pending_audit",
  ]),
  expectedReviewVersion: z.number().int().min(0),
  note: z.string().trim().max(500).optional(),
});

export const revisionSchema = z
  .object({
    expectedSnapshotId: z.string().trim().min(1).max(64),
    content: z.string().optional(),
    sourceSnapshotId: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => (value.content !== undefined) !== (value.sourceSnapshotId !== undefined));

export const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).optional(),
  reporterUserId: z.string().min(1).max(64).optional(),
});
export const cursorSchema = z.object({
  createdAt: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
});
export const snapshotPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  beforeRevision: z.coerce.number().int().min(1).optional(),
});
export const adminListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  reviewStatus: z
    .enum(["approved", "rejected", "unknown", "pending_openai", "pending_audit"])
    .optional(),
  deleted: z.enum(["true", "false"]).optional(),
  deletedBy: z.string().min(1).max(64).optional(),
  authorId: z.string().min(1).max(64).optional(),
  kind: z.enum(["comment", "image"]).optional(),
});
