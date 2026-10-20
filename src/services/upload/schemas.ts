import { z } from "zod";
import { getCommentLength } from "./commentLength";

const COMMENT_MAX_LENGTH = 500;
// A valid nine-character emoji token counts as two units: 250 tokens is the
// longest source that can fit within the submission limit.
const COMMENT_MAX_SOURCE_LENGTH = COMMENT_MAX_LENGTH / 2 * ":sns_001:".length;
const commentContentSchema = z.string().trim().min(1).refine(
  (content) => content.length <= COMMENT_MAX_SOURCE_LENGTH && getCommentLength(content) <= COMMENT_MAX_LENGTH,
  { message: "Comment must not exceed 500 characters." }
);

export const imagesQuerySchema = z.object({
  markerId: z.string().min(1).max(128).optional(),
  markerIds: z.string().max(4000).optional(),
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional(),
  publicOnly: z.enum(["1"]).optional()
});

export const commentsQuerySchema = z.object({
  markerId: z.string().min(1).max(128).optional(),
  markerIds: z.string().max(4000).optional(),
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  replyLimit: z.coerce.number().int().min(0).max(10).optional(),
  publicOnly: z.enum(["1"]).optional()
});

export const imageUploadFieldsSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: z.string().max(1000).optional()
});

export const commentSubmissionSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: commentContentSchema,
  parentId: z.string().min(1).max(64).optional()
});

export const commentEditSchema = z.object({
  content: commentContentSchema
});

export const commentTranslationSchema = z.object({
  commentIds: z.array(z.string().min(1).max(64)).min(1).max(100),
  targetLanguage: z.string().min(2).max(16),
  sourceLanguage: z.string().min(2).max(16).optional(),
  cachedOnly: z.boolean().optional()
});
