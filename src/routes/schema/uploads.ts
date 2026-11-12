import { z } from "zod";

import type { PublicCommentNode, PublicSubmissionImage } from "@/repositories/submission/types";
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
  parentSnapshotId: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Approved snapshot on which this edit is based. On COMMENT_EDIT_CONFLICT, refresh the comment and reconcile before resubmitting.",
    ),
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

export const submissionStatusSchema = z.enum([
  "pending_openai",
  "pending_audit",
  "active",
  "flagged",
  "stale",
]);
export const publicImageSchema = z
  .object({
    id: z.string(),
    snapshotId: z.string(),
    markerId: z.string(),
    url: z.string(),
    content: z.string().nullable(),
    author: z.object({ nickname: z.string(), publicUid: z.string() }).nullable(),
    status: submissionStatusSchema,
    upvoteCount: z.number(),
    flagCount: z.number(),
    upvoted: z.boolean().optional(),
    flagged: z.boolean().optional(),
    createdAt: z.string(),
  })
  .meta({ ref: "PublicImage" }) satisfies z.ZodType<PublicSubmissionImage>;
export const userImageSchema = publicImageSchema
  .extend({ poiHash: z.string(), poiType: z.string(), filePath: z.string() })
  .meta({ ref: "UserImage" });
const commentStructure = {
  id: z.string(),
  markerId: z.string(),
  parentId: z.string().nullable(),
  depth: z.number(),
};
const commentFields = {
  ...commentStructure,
  type: z.literal("comment"),
  snapshotId: z.string(),
  poiHash: z.string(),
  poiType: z.string(),
  content: z.string(),
  author: z
    .object({
      nickname: z.string(),
      publicUid: z.string(),
      avatar: z.number().optional(),
      karma: z.number().optional(),
    })
    .nullable(),
  status: submissionStatusSchema,
  score: z.number(),
  viewerVote: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  flagged: z.boolean().optional(),
  createdAt: z.string(),
};
export const commentNodeSchema: z.ZodType<PublicCommentNode> = z
  .discriminatedUnion("type", [
    z.object({
      ...commentFields,
      replyCount: z.number(),
      replies: z.array(z.lazy(() => commentNodeSchema)),
    }),
    z.object({
      ...commentStructure,
      type: z
        .literal("placeholder")
        .describe(
          "Structural connector for hidden content. Render its visible descendants without body, author, or interaction controls.",
        ),
      replyCount: z.number(),
      replies: z.array(z.lazy(() => commentNodeSchema)),
    }),
  ])
  .meta({ ref: "CommentNode" });
export const userCommentSchema = z
  .object({
    ...commentFields,
    flagCount: z.number(),
    replyCount: z.number().optional(),
    replies: z.array(commentNodeSchema).optional(),
  })
  .meta({ ref: "UserComment" });
export const publicImageListSchema = z.object({
  items: z.array(publicImageSchema),
  partial: z
    .boolean()
    .optional()
    .describe(
      "True when some requested markers could not be read, including on HTTP 200. Keep successful items and retry the failed markers.",
    ),
  failedMarkerIds: z
    .array(z.string())
    .optional()
    .describe(
      "Markers whose results are unavailable. Missing items for these markers do not establish an empty result.",
    ),
});
export const publicCommentListSchema = z.object({
  items: z.array(commentNodeSchema),
  partial: z
    .boolean()
    .optional()
    .describe(
      "True when some requested markers could not be read, including on HTTP 200. Keep successful items and retry the failed markers.",
    ),
  failedMarkerIds: z
    .array(z.string())
    .optional()
    .describe(
      "Markers whose results are unavailable. Missing items for these markers do not establish an empty result.",
    ),
});
export const userImageListSchema = z.object({ items: z.array(userImageSchema) });
export const userCommentListSchema = z.object({ items: z.array(userCommentSchema) });
const sectionErrorSchema = z.object({
  error: z.object({ code: z.string(), status: z.number(), message: z.string() }),
});
export const imageSectionsSchema = z.object({
  images: z.union([publicImageListSchema, sectionErrorSchema]),
  mine: z.union([userImageListSchema, sectionErrorSchema]),
});
export const imageListQuerySchema = imagesQuerySchema.extend({
  includeMine: z
    .enum(["1"])
    .optional()
    .describe(
      "Requires an active user; incompatible with publicOnly=1. Returns images and mine sections, with 207 on partial failure.",
    ),
});
export const imageItemSchema = z.object({ item: publicImageSchema });
// Context adds a bounded ancestor path and descendant truncation information.
export const commentItemSchema = z.object({
  item: z.object({
    targetId: z.string(),
    path: z.array(commentNodeSchema),
    replies: z.array(commentNodeSchema),
    repliesTruncated: z
      .boolean()
      .describe(
        "True when additional descendants were omitted. The returned replies are not the complete discussion.",
      ),
  }),
});
export const commentCreatedSchema = z.object({
  ok: z.literal(true),
  submission: z.object({
    id: z.string(),
    markerId: z.string(),
    parentId: z.string().nullable(),
    depth: z.number(),
    status: z.literal("pending_openai"),
    snapshotId: z.string(),
  }),
});
export const commentEditedSchema = commentCreatedSchema.extend({
  submission: commentCreatedSchema.shape.submission.extend({ status: submissionStatusSchema }),
});
export const imageCreatedSchema = z.object({
  ok: z.literal(true),
  submission: z.object({
    id: z.string(),
    markerId: z.string(),
    status: z.literal("pending_openai"),
    filePath: z.string(),
    snapshotId: z.string(),
  }),
  duplicatePoi: z
    .object({ markerId: z.string(), imageCount: z.number(), dashboardPath: z.string() })
    .nullable(),
});
export const imageVoteCreatedSchema = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  upvoteCount: z.number(),
});
export const imageVoteDeletedSchema = imageVoteCreatedSchema
  .omit({ created: true })
  .extend({ deleted: z.boolean() });
export const commentVoteResponseSchema = z.object({
  ok: z.literal(true),
  vote: z.number().describe("Resulting viewer vote: -1 downvote, 0 no vote, 1 upvote."),
  previousVote: z.number(),
  score: z.number(),
});
const flagResult = {
  ok: z.literal(true),
  status: submissionStatusSchema,
  flagCount: z.number(),
};
export const flagCreatedSchema = z.object({ ...flagResult, created: z.boolean() });
export const flagDeletedSchema = z.object({ ...flagResult, deleted: z.boolean() });
export const authorDeletionSchema = z.object({
  ok: z.literal(true),
  authorDeletedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
});
export const translationsResponseSchema = z.object({
  items: z.array(
    z.object({
      commentId: z.string(),
      snapshotId: z.string().optional(),
      translatedContent: z.string().optional(),
      sourceLanguage: z.string().optional(),
      targetLanguage: z.string(),
      provider: z.string(),
      glossaryApplied: z.boolean(),
      cached: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
