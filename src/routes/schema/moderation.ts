import { z } from "zod";

import type { HistoricalSnapshot, HistoryEvent } from "@/repositories/submission/history";
import type {
  ManagementPage,
  ManagementSubmission,
} from "@/repositories/submission/managementReads";
import type { ImageCoverageResponse } from "@/services/moderation/imageCoverage";
import type { OrphanImageReport } from "@/services/moderation/orphanImages";
import type { RevisionContent } from "@/services/ugc/contract/revisionContent";

import { reviewStatusSchema } from "./me";
import { publicImageSchema, submissionStatusSchema } from "./uploads";

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

const managementSnapshotSchema = z.object({
  snapshotId: z.string(),
  revision: z.number(),
  reviewVersion: z.number(),
  content: z.string().nullable(),
  filePath: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  reviewStatus: reviewStatusSchema,
  createdAt: z.string(),
});
export const managementSubmissionSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "comment"]),
  markerId: z.string(),
  poiHash: z.string(),
  poiType: z.string(),
  userId: z.string(),
  parentId: z.string().nullable(),
  commentDepth: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  frontier: managementSnapshotSchema,
  publicSnapshot: managementSnapshotSchema.nullable(),
  flagCount: z.number(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  lifecycleVersion: z.number(),
  authorDeletedAt: z.string().nullable(),
  adminDeletedAt: z.string().nullable(),
  adminDeletedBy: z.string().nullable(),
  status: submissionStatusSchema,
  submitter: z
    .object({
      uid: z.string(),
      uidNumber: z.number().nullable(),
      publicUid: z.string().nullable(),
      role: z.string().nullable(),
      karma: z.number().nullable(),
      nickname: z.string().nullable(),
      avatar: z.number().nullable(),
    })
    .nullable(),
  latestReviewAudit: z
    .object({
      id: z.string(),
      snapshotId: z.string(),
      fromStatus: reviewStatusSchema,
      toStatus: reviewStatusSchema,
      source: z.enum(["ai", "admin"]),
      adminUserId: z.string().nullable(),
      note: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
}) satisfies z.ZodType<ManagementSubmission>;
export const managementPageSchema = z.object({
  items: z.array(managementSubmissionSchema),
  limit: z.number(),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  stats: z.object({
    total: z.number(),
    byKind: z.array(z.object({ kind: z.enum(["image", "comment"]), count: z.number() })),
    byType: z.array(z.object({ type: z.string(), count: z.number() })),
    byStatus: z.array(z.object({ status: submissionStatusSchema, count: z.number() })),
    byReviewStatus: z.array(z.object({ reviewStatus: reviewStatusSchema, count: z.number() })),
  }),
}) satisfies z.ZodType<ManagementPage>;
const coverageMetricSchema = z.object({
  totalPoints: z.number(),
  coveredPoints: z.number(),
  missingPoints: z.number(),
  imageCount: z.number(),
  coverageRate: z.number(),
});
const coverageCategorySchema = coverageMetricSchema.extend({ key: z.string(), name: z.string() });
const coverageTypeSchema = coverageCategorySchema.extend({
  category: z.string(),
  missingMarkers: z.array(z.object({ markerId: z.string(), shortUrl: z.string() })),
});
export const imageCoverageResponseSchema = z.object({
  generatedAt: z.string(),
  scope: z.enum(["prod", "test"]),
  manifest: z.object({
    schemaVersion: z.number(),
    generatedAt: z.string(),
    sourceCommit: z.string(),
  }),
  total: coverageMetricSchema,
  regions: z.array(
    coverageMetricSchema.extend({
      key: z.string(),
      name: z.string(),
      categories: z.array(coverageCategorySchema),
      types: z.array(coverageTypeSchema),
    }),
  ),
}) satisfies z.ZodType<ImageCoverageResponse>;
export const orphanImagesResponseSchema = z.object({
  generatedAt: z.string(),
  items: z.array(
    z.object({
      key: z.string(),
      url: z.string(),
      sizeBytes: z.number(),
      uploadedAt: z.string(),
      etag: z.string(),
      contentType: z.string().nullable(),
      sourceMimeType: z.string().nullable(),
      convertedToWebp: z.boolean(),
      storageClass: z.string(),
    }),
  ),
  stats: z.object({
    r2ObjectCount: z.number(),
    r2SizeBytes: z.number(),
    referencedFileCount: z.number(),
    orphanObjectCount: z.number(),
    orphanSizeBytes: z.number(),
  }),
}) satisfies z.ZodType<OrphanImageReport>;
export const duplicateMarkersResponseSchema = z.object({
  items: z.array(
    z.object({
      markerId: z.string(),
      poiHash: z.string(),
      poiType: z.string(),
      imageCount: z.number(),
      latestCreatedAt: z.string(),
      latestImage: publicImageSchema.nullable(),
    }),
  ),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export const duplicateImagesResponseSchema = z.object({
  markerId: z.string(),
  items: z.array(publicImageSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export const warningResponseSchema = z.object({
  ok: z.literal(true),
  publicUid: z.string(),
  provider: z.string(),
  messageId: z.string().nullable(),
});
export const moderationUpdatedSchema = z.object({
  ok: z.literal(true),
  actorUserId: z.string(),
  outcome: z.enum(["committed", "no_op"]),
});
const moderationStats = {
  processed: z.number(),
  active: z.number(),
  pendingAudit: z.number(),
  stale: z.number(),
};
export const moderationRunSchema = z.discriminatedUnion("mode", [
  z.object({
    ok: z.literal(true),
    mode: z.literal("selected"),
    requested: z.number(),
    ...moderationStats,
  }),
  z.object({
    ok: z.literal(true),
    mode: z.literal("queue"),
    requested: z.number(),
    enqueued: z.number(),
    ...moderationStats,
  }),
]);
export const karmaRunSchema = z.object({
  ok: z.literal(true),
  evaluated: z.boolean(),
  selected: z.number(),
  dirtySelected: z.number(),
  sweepSelected: z.number(),
  updated: z.number(),
  cycleComplete: z.boolean(),
  nextRunAt: z.number().nullable(),
});
export const archiveTestImagesSchema = z.object({
  ok: z.literal(true),
  prefix: z.string(),
  archivedRows: z.number(),
  retainedObjects: z.literal(true),
  deletedObjects: z.literal(0),
  deletedRows: z.literal(0),
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

export const revisionInputSchema = z
  .object({
    expectedSnapshotId: z.string().trim().min(1).max(64),
    content: z.string().optional(),
    sourceSnapshotId: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => (value.content !== undefined) !== (value.sourceSnapshotId !== undefined))
  .describe(
    "Supply exactly one of content or sourceSnapshotId. The baseline must be the current frontier.",
  );

export const revisionSchema = revisionInputSchema.transform(
  ({ content, sourceSnapshotId, ...input }) => {
    // The refinement guarantees exactly one of the existing request fields.
    const change: RevisionContent =
      content !== undefined
        ? { type: "text", content }
        : { type: "reuse", sourceSnapshotId: sourceSnapshotId! };
    return { ...input, change };
  },
);

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

export const managementItemSchema = z.object({ item: managementSubmissionSchema });
const historyEventSchema = z.object({
  id: z.string(),
  object: z.enum(["submission", "snapshot", "report"]),
  action: z.enum([
    "created",
    "reviewed",
    "deleted",
    "restored",
    "activated",
    "withdrawn",
    "cleared",
  ]),
  actorUserId: z.string().nullable(),
  snapshotId: z.string().nullable(),
  reporterUserId: z.string().nullable(),
  fromStatus: z.string().nullable(),
  toStatus: z.string().nullable(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  operationId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<HistoryEvent>;
export const historyResponseSchema = z.object({
  items: z.array(historyEventSchema),
  nextCursor: z.string().nullable(),
});
const historicalSnapshotSchema = managementSnapshotSchema.extend({
  creatorUserId: z.string(),
  creationSource: z.enum(["user", "admin"]),
  baselineSnapshotId: z.string().nullable(),
  sourceSnapshotId: z.string().nullable(),
  note: z.string().nullable(),
}) satisfies z.ZodType<HistoricalSnapshot>;
export const snapshotPageResponseSchema = z.object({
  items: z.array(historicalSnapshotSchema),
  nextBeforeRevision: z.number().nullable(),
});
export const lifecycleResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["committed", "no_op"]),
  kind: z.enum(["image", "comment"]),
  markerId: z.string(),
  userId: z.string(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  lifecycleVersion: z.number(),
});
export const reviewCorrectionResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["committed", "no_op"]),
});
export const revisionResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["appended", "unchanged"]),
  submission: z.object({
    id: z.string(),
    markerId: z.string(),
    parentId: z.string().nullable(),
    depth: z.number(),
    snapshotId: z.string(),
    status: submissionStatusSchema,
  }),
});
