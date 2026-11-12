import { z } from "zod";

import type { ManagementPage } from "@/repositories/submission/managementReads";
import type { ImageCoverageResponse } from "@/services/moderation/imageCoverage";
import type { OrphanImageReport } from "@/services/moderation/orphanImages";

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
  content: z.string().nullable(),
  filePath: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  reviewStatus: reviewStatusSchema,
  createdAt: z.string(),
});
export const managementPageSchema = z.object({
  items: z.array(
    z.object({
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
    }),
  ),
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
