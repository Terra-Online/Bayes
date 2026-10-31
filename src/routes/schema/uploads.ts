import { z } from "zod";

import { commentContentSchema } from "@/services/ugc/contract/commentContent";

export const imagesQuerySchema = z.object({
  markerId: z.string().min(1).max(128).optional(),
  markerIds: z.string().max(4000).optional(),
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional(),
  publicOnly: z.enum(["1"]).optional(),
});

export const commentsQuerySchema = z.object({
  markerId: z.string().min(1).max(128).optional(),
  markerIds: z.string().max(4000).optional(),
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  replyLimit: z.coerce.number().int().min(0).max(10).optional(),
  publicOnly: z.enum(["1"]).optional(),
});

export const imageUploadFieldsSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: z.string().max(1000).optional(),
});

export const commentSubmissionSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: commentContentSchema,
  parentId: z.string().min(1).max(64).optional(),
});

export const commentEditSchema = z.object({
  parentSnapshotId: z.string().min(1).max(64),
  content: commentContentSchema,
});

export const commentTranslationSchema = z.object({
  commentIds: z.array(z.string().min(1).max(64)).min(1).max(100),
  targetLanguage: z.string().min(2).max(16),
  sourceLanguage: z.string().min(2).max(16).optional(),
  cachedOnly: z.boolean().optional(),
});

export const imageQuerySchema = imagesQuerySchema
  .pick({
    markerId: true,
    scope: true,
  })
  .required({ markerId: true });

export const commentQuerySchema = commentsQuerySchema
  .pick({
    markerId: true,
  })
  .required({ markerId: true });

export const submissionReportSchema = z.object({
  snapshotId: z.string().min(1).max(64),
});
