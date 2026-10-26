import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { getRuntimeConfig } from "@/lib/config";
import { ApiError } from "@/lib/errors";
import { createRedisClient } from "@/lib/redis";
import { requireAuth, requireRole } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import { invalidateUploadCaches } from "@/publicRead/client/invalidate";
import {
  listDuplicateImageMarkers,
  listDuplicateMarkerImages,
} from "@/repositories/submission-duplicates";
import {
  getReviewSubmissionStats,
  getReviewSubmissions,
  markImageSubmissionsStaleByFilePathPrefix,
} from "@/repositories/submission-review";
import { ALL_STATUSES, type SubmissionStatus } from "@/repositories/submission/types";
import {
  updateSchema,
  listSchema,
  duplicateImagesQuerySchema,
  imageCoverageQuerySchema,
  duplicateMarkerImagesQuerySchema,
  runSchema,
  warningSchema,
} from "@/routes/schema/moderation";
import { evaluateKarmaBatch } from "@/services/karma/evaluation";
import { runAutoModerationRequest } from "@/services/moderation/autoModeration";
import { getImageCoverage } from "@/services/moderation/imageCoverage";
import { applyManualModeration } from "@/services/moderation/manualModeration";
import { getOrphanImages } from "@/services/moderation/orphanImages";
import { sendModerationWarning } from "@/services/moderation/warnings";
import type { AppEnv } from "@/types/app";

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
  scope: "test" | "prod" | undefined,
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

export function createRoutes() {
  return new Hono<AppEnv>()
    .use(
      "*",
      createMiddleware<AppEnv>(async (c, next) => {
        if (isModerationLocked(c.env.LOCK_MODERATION_ENDPOINTS)) {
          throw new ApiError(
            503,
            "MODERATION_TEMPORARILY_DISABLED",
            "Moderation endpoints are temporarily disabled during stabilization.",
          );
        }
        await next();
      }),
    )
    .post("/warnings", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const parsed = warningSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid moderation warning payload.",
          parsed.error.flatten(),
        );
      }

      const result = await sendModerationWarning(c.env, parsed.data);
      if (!result) {
        throw new ApiError(404, "USER_NOT_FOUND", "No user was found for the supplied public UID.");
      }

      return c.json({
        ok: true,
        publicUid: result.publicUid,
        provider: result.delivery.provider,
        messageId: result.delivery.id ?? null,
      });
    })
    .get("/pending", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
      const parsed = listSchema.safeParse({
        submissionId: c.req.query("submissionId"),
        status: c.req.query("status"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: c.req.query("limit"),
      });
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid moderation query.",
          parsed.error.flatten(),
        );
      }
      const fromDate = parsed.data.from ? new Date(parsed.data.from) : null;
      const toDate = parsed.data.to ? new Date(parsed.data.to) : null;
      if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation query date range.", {
          from: parsed.data.from,
          to: parsed.data.to,
        });
      }

      const filters = {
        submissionId: parsed.data.submissionId,
        statuses: parseStatuses(parsed.data.status),
        createdFrom: fromDate ? toSqlTimestamp(fromDate) : undefined,
        createdTo: toDate ? toSqlTimestamp(toDate) : undefined,
      };
      const limit = parsed.data.limit ?? 1000;
      const [rows, stats] = await Promise.all([
        getReviewSubmissions(c.env.DB, {
          ...filters,
          limit,
        }),
        getReviewSubmissionStats(c.env.DB, filters),
      ]);
      return c.json({
        items: rows,
        stats,
        limit,
      });
    })
    .get("/images/coverage", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const parsed = imageCoverageQuerySchema.safeParse({
        scope: c.req.query("scope"),
      });
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid image coverage query.",
          parsed.error.flatten(),
        );
      }

      const requestedScope = parsed.data.scope ?? "prod";
      return c.json(
        await getImageCoverage(c.env.DB, {
          scope: requestedScope,
          imageScope: resolveImageScope("", requestedScope),
        }),
      );
    })
    .get("/images/orphans", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const config = getRuntimeConfig(c.env);
      return c.json(
        await getOrphanImages({
          db: c.env.DB,
          bucket: c.env.UGC_BUCKET,
          assetBaseUrl: config.ugcAssetBaseUrl,
        }),
      );
    })
    .get(
      "/images/duplicates",
      requireAuth,
      requireRole(["p", "a"]),
      rateLimit("auth"),
      async (c) => {
        const parsed = duplicateImagesQuerySchema.safeParse({
          scope: c.req.query("scope"),
          limit: c.req.query("limit"),
          offset: c.req.query("offset"),
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid duplicate image query.",
            parsed.error.flatten(),
          );
        }

        const config = getRuntimeConfig(c.env);
        const scope = resolveImageScope(config.ugcUploadPathPrefix, parsed.data.scope);
        const result = await listDuplicateImageMarkers(c.env.DB, {
          assetBaseUrl: resolvePublicAssetBaseUrl(c.req.url, config.ugcAssetBaseUrl),
          pathPrefix: scope.pathPrefix,
          excludePathPrefix: scope.excludePathPrefix,
          limit: parsed.data.limit ?? 50,
          offset: parsed.data.offset ?? 0,
        });

        return c.json({
          items: result.items,
          total: result.total,
          limit: parsed.data.limit ?? 50,
          offset: parsed.data.offset ?? 0,
        });
      },
    )
    .get(
      "/images/duplicates/:markerId",
      requireAuth,
      requireRole(["p", "a"]),
      rateLimit("auth"),
      async (c) => {
        const markerId = c.req.param("markerId")?.trim();
        if (!markerId) {
          throw new ApiError(422, "VALIDATION_ERROR", "markerId is required.");
        }

        const parsed = duplicateMarkerImagesQuerySchema.safeParse({
          scope: c.req.query("scope"),
          limit: c.req.query("limit"),
          offset: c.req.query("offset"),
        });
        if (!parsed.success) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid duplicate image query.",
            parsed.error.flatten(),
          );
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
          viewerUserId: user.uid,
        });

        return c.json({
          markerId,
          items: result.items,
          total: result.total,
          limit: parsed.data.limit ?? 100,
          offset: parsed.data.offset ?? 0,
        });
      },
    )
    .patch("/:id/status", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
      const submissionId = c.req.param("id");
      if (!submissionId) {
        throw new ApiError(422, "VALIDATION_ERROR", "Submission id is required.");
      }

      const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid moderation payload.",
          parsed.error.flatten(),
        );
      }

      await applyManualModeration(
        {
          bindings: c.env,
          defer: (task) => c.executionCtx.waitUntil(task),
        },
        {
          submissionId,
          nextStatus: parsed.data.status,
          moderationNote: parsed.data.moderationNote,
        },
      );

      return c.json({ ok: true });
    })
    .post("/run", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const parsed = runSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Invalid moderation run payload.",
          parsed.error.flatten(),
        );
      }

      const result = await runAutoModerationRequest(c.env, {
        submissionIds: parsed.data.ids,
        limit: parsed.data.limit,
      });
      return c.json({ ok: true, ...result });
    })
    .post("/run-once", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const result = await runAutoModerationRequest(c.env, { limit: 5 });
      return c.json({ ok: true, ...result });
    })
    .post("/karma/run-once", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const redis = createRedisClient(c.env);
      let result;
      try {
        result = await evaluateKarmaBatch(c.env.DB, redis);
      } catch (error) {
        throw new ApiError(500, "KARMA_EVALUATION_FAILED", "Karma evaluation failed.", {
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      return c.json({
        ok: true,
        ...result,
      });
    })
    .delete("/test-images", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
      const config = getRuntimeConfig(c.env);
      const prefix = config.ugcUploadPathPrefix || "_test";
      if (prefix !== "_test") {
        throw new ApiError(
          409,
          "TEST_PREFIX_DISABLED",
          "Test image cleanup is only available for the _test prefix.",
        );
      }

      const archived = await markImageSubmissionsStaleByFilePathPrefix(
        c.env.DB,
        prefix,
        "Archived from the test namespace; object retained by append-only policy.",
      );
      c.executionCtx.waitUntil(
        Promise.all(
          archived.markerIds.map((markerId) =>
            invalidateUploadCaches({
              kv: c.env.OEM_KV,
              kind: "image",
              markerId,
            }),
          ),
        ),
      );

      return c.json({
        ok: true,
        prefix,
        archivedRows: archived.changedRows,
        retainedObjects: true,
        deletedObjects: 0,
        deletedRows: 0,
      });
    })
    .delete("/stale", requireAuth, requireRole(["a"]), rateLimit("auth"), async () => {
      throw new ApiError(
        409,
        "APPEND_ONLY_RETENTION",
        "Stale submissions and their R2 objects are retained. Update status instead of deleting records.",
      );
    });
}
