import { Hono, type Context } from "hono";
import { z } from "zod";
import { getRuntimeConfig } from "../lib/config";
import { ApiError } from "../lib/errors";
import { RECALL_MODERATION_NOTE_PREFIX } from "../lib/moderation";
import { createRedisClient } from "../lib/redis";
import { requireAuth, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  listDuplicateImageMarkers,
  listDuplicateMarkerImages
} from "../repositories/submission-duplicates";
import {
  deleteSubmissionsByStatus,
  deleteSubmissionsByFilePathPrefix,
  getSubmissionFilePathsByStatus,
  getReviewSubmissionStats,
  getReviewSubmissions
} from "../repositories/submission-review";
import {
  ALL_STATUSES,
  type SubmissionRecord,
  type SubmissionStatus
} from "../repositories/submission/types";
import { clearSubmissionFlags } from "../repositories/submission/flagSubmission";
import { getSubmissionById, updateSubmissionStatus } from "../repositories/submission/statusSubmission";
import { applyUserPointsDelta } from "../repositories/users";
import { deletePublicMarkerCommentCache } from "../middleware/cache/publicMarkerComments";
import { deletePublicMarkerImageCache } from "../middleware/cache/publicMarkerImages";
import { prewarmPublicUgcAsset } from "../middleware/cache/publicUgcAssets";
import { evaluateKarmaBatch, markKarmaDirty } from "../services/karma/evaluation";
import { getModerationPointsDeltaWithDailyBackoff } from "../services/karma/moderationPoints";
import { moderateSubmissionIds } from "../services/moderation/core";
import { ensureModerationBackfill, enqueueApprovedCommentTransPrewarm } from "../services/moderation/queue";
import { notifyPendingOpenAICompleted, notifySubmissionApproved } from "../services/moderation/notifications";
import type { AppEnv } from "../types/app";

const updateSchema = z.object({
  status: z.enum(["pending_openai", "pending_audit", "active", "flagged", "remove_request", "stale"]),
  moderationNote: z.string().max(500).optional()
});

const listSchema = z.object({
  status: z.string().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional()
});

const duplicateImagesQuerySchema = z.object({
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional()
});

const duplicateMarkerImagesQuerySchema = z.object({
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional()
});

const runSelectedSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500)
});

const runSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional()
});

const STATUS_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending_openai: ["active", "pending_audit", "stale"],
  pending_audit: ["active", "stale"],
  active: ["stale"],
  flagged: ["active", "stale"],
  remove_request: ["active", "stale"],
  stale: ["active"]
};

function isModerationLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function parseStatuses(raw: string | undefined): SubmissionStatus[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const statuses = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SubmissionStatus => ALL_STATUSES.includes(item as SubmissionStatus));

  return statuses.length > 0 ? [...new Set(statuses)] : undefined;
}

function toSqlTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function resolvePublicAssetBaseUrl(requestUrl: string, configuredBaseUrl: string): string {
  const url = new URL(requestUrl);
  if (isLocalHostname(url.hostname)) {
    return `${url.origin}/uploads/v1/public-file`;
  }
  return configuredBaseUrl;
}

function resolveImageScope(
  configuredPrefix: string,
  scope: "test" | "prod" | undefined
): { pathPrefix?: string; excludePathPrefix?: string } {
  if (configuredPrefix === "_test") {
    return { pathPrefix: "_test" };
  }

  if (scope === "test") {
    return { pathPrefix: "_test" };
  }

  if (scope === "prod") {
    return { excludePathPrefix: "_test" };
  }

  return {};
}

function assertStatusTransition(from: SubmissionStatus, to: SubmissionStatus): void {
  if (from === to) {
    return;
  }

  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new ApiError(409, "INVALID_STATUS_TRANSITION", `Cannot move submission from ${from} to ${to}.`, {
      from,
      to,
      allowed: STATUS_TRANSITIONS[from]
    });
  }
}

function shouldApplyModerationPoints(
  currentStatus: SubmissionStatus,
  nextStatus: SubmissionStatus,
  moderationNote: string | null
): boolean {
  if (currentStatus === nextStatus || (nextStatus !== "active" && nextStatus !== "stale")) {
    return false;
  }

  if (nextStatus === "stale" && moderationNote?.startsWith(RECALL_MODERATION_NOTE_PREFIX)) {
    return false;
  }

  return true;
}

async function runModeration(
  c: Context<AppEnv>,
  payload: {
    ids?: string[];
    limit?: number;
  }
) {
  const config = getRuntimeConfig(c.env);
  const redis = createRedisClient(c.env);
  const options = {
    openAiApiKey: c.env.OPENAI_API_KEY,
    assetBaseUrl: config.ugcAssetBaseUrl,
    ugcBucket: c.env.UGC_BUCKET,
    ugcKv: c.env.OEM_KV,
    redis,
    surgeModeEnabled: config.surgeModeEnabled,
    surgeBackoffMultiplier: config.surgeBackoffMultiplier,
    skipAiModeration: config.skipAiModeration,
    localAutoApprove: config.localUploadAutoApprove,
    enqueueApprovedCommentTransPrewarm: (submissionId: string) =>
      enqueueApprovedCommentTransPrewarm(c.env, submissionId, "auto_moderation"),
    enqueueApprovalNotice: (submission: SubmissionRecord, previousStatus: SubmissionStatus) =>
      notifySubmissionApproved(c.env, {
        submission,
        previousStatus,
        source: "auto_moderation"
      })
  };

  if (payload.ids && payload.ids.length > 0) {
    const processed = await moderateSubmissionIds(
      c.env.DB,
      options,
      payload.ids,
      25_000
    );
    c.executionCtx.waitUntil(
      notifyPendingOpenAICompleted(c.env, {
        mode: "selected",
        requested: payload.ids.length,
        stats: processed.stats
      })
    );

    return {
      ok: true,
      mode: "selected" as const,
      requested: payload.ids.length,
      processed: processed.processed,
      active: processed.stats.active,
      pendingAudit: processed.stats.pendingAudit,
      stale: processed.stats.stale
    };
  }

  const limit = payload.limit ?? 5;
  const enqueued = await ensureModerationBackfill(c.env, limit);

  return {
    ok: true,
    mode: "queue" as const,
    requested: limit,
    enqueued,
    processed: 0,
    active: 0,
    pendingAudit: 0,
    stale: 0
  };
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const listed = await bucket.list({
      prefix: `${prefix}/`,
      cursor,
      limit: 1000
    });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) {
      await Promise.all(keys.map((key) => bucket.delete(key)));
      deleted += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}

async function deleteR2Objects(bucket: R2Bucket, keys: string[]): Promise<number> {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  let deleted = 0;
  for (let index = 0; index < uniqueKeys.length; index += 100) {
    const batch = uniqueKeys.slice(index, index + 100);
    await Promise.all(batch.map((key) => bucket.delete(key)));
    deleted += batch.length;
  }
  return deleted;
}

export function createModerationRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    if (isModerationLocked(c.env.LOCK_MODERATION_ENDPOINTS)) {
      throw new ApiError(
        503,
        "MODERATION_TEMPORARILY_DISABLED",
        "Moderation endpoints are temporarily disabled during stabilization."
      );
    }
    await next();
  });

  app.get("/pending", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const parsed = listSchema.safeParse({
      status: c.req.query("status"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      limit: c.req.query("limit")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation query.", parsed.error.flatten());
    }
    const fromDate = parsed.data.from ? new Date(parsed.data.from) : null;
    const toDate = parsed.data.to ? new Date(parsed.data.to) : null;
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation query date range.", {
        from: parsed.data.from,
        to: parsed.data.to
      });
    }

    const filters = {
      statuses: parseStatuses(parsed.data.status),
      createdFrom: fromDate ? toSqlTimestamp(fromDate) : undefined,
      createdTo: toDate ? toSqlTimestamp(toDate) : undefined
    };
    const limit = parsed.data.limit ?? 1000;
    const [rows, stats] = await Promise.all([
      getReviewSubmissions(c.env.DB, {
        ...filters,
        limit
      }),
      getReviewSubmissionStats(c.env.DB, filters)
    ]);
    return c.json({
      items: rows,
      stats,
      limit
    });
  });

  app.get("/statuses", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    return c.json({
      statuses: ALL_STATUSES,
      transitions: STATUS_TRANSITIONS
    });
  });

  app.get("/images/duplicates", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const parsed = duplicateImagesQuerySchema.safeParse({
      scope: c.req.query("scope"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid duplicate image query.", parsed.error.flatten());
    }

    const config = getRuntimeConfig(c.env);
    const scope = resolveImageScope(config.ugcUploadPathPrefix, parsed.data.scope);
    const result = await listDuplicateImageMarkers(c.env.DB, {
      assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0
    });

    return c.json({
      items: result.items,
      total: result.total,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0
    });
  });

  app.get("/images/duplicates/:markerId", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const markerId = c.req.param("markerId")?.trim();
    if (!markerId) {
      throw new ApiError(422, "VALIDATION_ERROR", "markerId is required.");
    }

    const parsed = duplicateMarkerImagesQuerySchema.safeParse({
      scope: c.req.query("scope"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid duplicate image query.", parsed.error.flatten());
    }

    const config = getRuntimeConfig(c.env);
    const scope = resolveImageScope(config.ugcUploadPathPrefix, parsed.data.scope);
    const user = c.get("authUser");
    const result = await listDuplicateMarkerImages(c.env.DB, {
      markerId,
      assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
      pathPrefix: scope.pathPrefix,
      excludePathPrefix: scope.excludePathPrefix,
      limit: parsed.data.limit ?? 100,
      offset: parsed.data.offset ?? 0,
      viewerUserId: user?.uid
    });

    return c.json({
      markerId,
      items: result.items,
      total: result.total,
      limit: parsed.data.limit ?? 100,
      offset: parsed.data.offset ?? 0
    });
  });

  app.patch("/:id/status", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const submissionId = c.req.param("id");
    if (!submissionId) {
      throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
    }

    const parsed = updateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation payload.", parsed.error.flatten());
    }

    const current = await getSubmissionById(c.env.DB, submissionId);
    if (!current) {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission was not found.");
    }
    assertStatusTransition(current.status, parsed.data.status);

    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      status: parsed.data.status,
      moderationNote: parsed.data.moderationNote
    });
    if (current.status === "flagged" && parsed.data.status === "active") {
      await clearSubmissionFlags(c.env.DB, submissionId);
    }
    if (current.status !== "active" && parsed.data.status === "active" && current.kind === "image") {
      const config = getRuntimeConfig(c.env);
      c.executionCtx.waitUntil(prewarmPublicUgcAsset(config.ugcAssetBaseUrl, current.filePath));
    }
    if (current.kind === "image") {
      c.executionCtx.waitUntil(deletePublicMarkerImageCache(c.env.OEM_KV, current.markerId));
    } else {
      c.executionCtx.waitUntil(deletePublicMarkerCommentCache(c.env.OEM_KV, current.markerId));
      if (current.status !== "active" && parsed.data.status === "active") {
        c.executionCtx.waitUntil(
          enqueueApprovedCommentTransPrewarm(c.env, submissionId, "manual_moderation")
        );
      }
    }
    if (current.status !== "active" && parsed.data.status === "active") {
      c.executionCtx.waitUntil(
        notifySubmissionApproved(c.env, {
          submission: current,
          previousStatus: current.status,
          source: "manual_moderation"
        })
      );
    }
    const effectiveModerationNote = parsed.data.moderationNote ?? current.moderationNote;
    if (shouldApplyModerationPoints(current.status, parsed.data.status, effectiveModerationNote)) {
      const reviewStatus = parsed.data.status === "active" ? "active" : "stale";
      const redis = createRedisClient(c.env);
      const config = getRuntimeConfig(c.env);
      await applyUserPointsDelta(
        c.env.DB,
        current.userId,
        await getModerationPointsDeltaWithDailyBackoff(redis, {
          userId: current.userId,
          kind: current.kind,
          status: reviewStatus,
          role: current.submitter?.role,
          surgeModeEnabled: config.surgeModeEnabled,
          surgeBackoffMultiplier: config.surgeBackoffMultiplier
        })
      );
      await markKarmaDirty(redis, current.userId);
    }

    return c.json({ ok: true });
  });

  app.post("/run", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation run payload.", parsed.error.flatten());
    }

    return c.json(await runModeration(c, parsed.data));
  });

  app.post("/run-once", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    return c.json(await runModeration(c, { limit: 5 }));
  });

  app.post("/run-selected", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    const parsed = runSelectedSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation selection.", parsed.error.flatten());
    }

    return c.json(await runModeration(c, { ids: parsed.data.ids }));
  });

  app.post("/karma/run-once", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    const redis = createRedisClient(c.env);
    let result;
    try {
      result = await evaluateKarmaBatch(c.env.DB, redis);
    } catch (error) {
      throw new ApiError(500, "KARMA_EVALUATION_FAILED", "Karma evaluation failed.", {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    return c.json({
      ok: true,
      ...result
    });
  });

  app.delete("/test-images", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    const config = getRuntimeConfig(c.env);
    const prefix = config.ugcUploadPathPrefix || "_test";
    if (prefix !== "_test") {
      throw new ApiError(409, "TEST_PREFIX_DISABLED", "Test image cleanup is only available for the _test prefix.");
    }

    const deletedObjects = await deleteR2Prefix(c.env.UGC_BUCKET, prefix);
    const deletedRows = await deleteSubmissionsByFilePathPrefix(c.env.DB, prefix);

    return c.json({
      ok: true,
      prefix,
      deletedObjects,
      deletedRows
    });
  });

  app.delete("/stale", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    const filePaths: string[] = [];
    let offset = 0;
    for (;;) {
      const batch = await getSubmissionFilePathsByStatus(c.env.DB, "stale", 1000, offset);
      if (batch.length === 0) {
        break;
      }
      filePaths.push(...batch);
      if (batch.length < 1000) {
        break;
      }
      offset += batch.length;
    }

    const deletedObjects = await deleteR2Objects(c.env.UGC_BUCKET, filePaths);
    const deletedRows = await deleteSubmissionsByStatus(c.env.DB, "stale");

    return c.json({
      ok: true,
      status: "stale",
      deletedObjects,
      deletedRows
    });
  });

  return app;
}
