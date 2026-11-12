import { z } from "zod";

import { userResponseSchema } from "./auth";
import { submissionStatusSchema } from "./uploads";

export const contributionQuerySchema = z.object({
  kind: z.enum(["image", "comment"]).optional(),
  status: z.enum(["pending_openai", "pending_audit", "active", "flagged", "stale"]).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const reviewStatusSchema = z.enum([
  "pending_openai",
  "pending_audit",
  "approved",
  "rejected",
  "unknown",
]);
const reviewKeySchema = z.enum(["uploaded", "ai", "manual", "public", "archived"]);
const reviewTimes = z.object({
  uploaded: z.string().nullable(),
  ai: z.string().nullable(),
  manual: z.string().nullable(),
  public: z.string().nullable(),
  archived: z.string().nullable(),
});
export const overviewResponseSchema = z.object({
  user: userResponseSchema,
  contributions: z.object({
    imageCount: z.number(),
    commentCount: z.number(),
    pendingCount: z.number(),
  }),
});
export const contributionPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["image", "comment"]),
      markerId: z.string(),
      poiType: z.string(),
      content: z.string().nullable(),
      previewUrl: z.string().nullable(),
      status: submissionStatusSchema,
      snapshotId: z.string(),
      revision: z.number(),
      reviewStatus: reviewStatusSchema,
      deletedAt: z.string().nullable().optional(),
      deletedBy: z.string().nullable().optional(),
      authorDeletedAt: z.string().nullable(),
      adminDeletedAt: z.string().nullable(),
      visibility: z.enum(["public", "private", "unavailable"]),
      createdAt: z.string(),
      review: z.object({
        manual: z.boolean(),
        published: z.boolean(),
        times: reviewTimes,
        path: z.array(z.object({ key: reviewKeySchema, at: z.string().nullable() })),
        events: z
          .array(
            z.object({
              id: z.string(),
              snapshotId: z.string(),
              from: reviewStatusSchema,
              to: reviewStatusSchema,
              source: z.enum(["ai", "admin"]),
              adminUserId: z.string().nullable(),
              note: z.string().nullable(),
              at: z.string(),
            }),
          )
          .readonly(),
      }),
    }),
  ),
  nextCursor: z.string().nullable(),
});
