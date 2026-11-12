import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";

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
import { archiveTestImageSubmissions } from "@/repositories/submission-review";
import { listManagementSubmissions } from "@/repositories/submission/managementReads";
import { ALL_STATUSES, type SubmissionStatus } from "@/repositories/submission/types";
import {
  operation,
  sessionSecurity,
  jsonResponse,
  apiErrorSchema,
} from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/moderation";
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
    .post(
      "/warnings",
      operation("sendModerationWarning", "Moderation", "Send a warning to a public UID", {
        errors: [404, 429, 503],
        security: sessionSecurity,
        description: "Administrator role and unlocked moderation required.",
        body: docs.warningSchema,
        response: docs.warningResponseSchema,
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
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
          throw new ApiError(
            404,
            "USER_NOT_FOUND",
            "No user was found for the supplied public UID.",
          );
        }

        return c.json({
          ok: true,
          publicUid: result.publicUid,
          provider: result.delivery.provider,
          messageId: result.delivery.id ?? null,
        } satisfies z.output<typeof docs.warningResponseSchema>);
      },
    )
    .get(
      "/pending",
      operation("listModerationSubmissions", "Moderation", "List submissions for management", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Reviewer or administrator role and unlocked moderation required.",
        query: docs.listSchema,
        response: docs.managementPageSchema,
      }),
      requireAuth,
      requireRole(["p", "a"]),
      rateLimit("auth"),
      async (c) => {
        const parsed = listSchema.safeParse({
          submissionId: c.req.query("submissionId"),
          status: c.req.query("status"),
          mode: c.req.query("mode"),
          offset: c.req.query("offset"),
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
        if (
          !parsed.data.submissionId &&
          parsed.data.mode !== "reports" &&
          fromDate &&
          toDate &&
          fromDate.getTime() > toDate.getTime()
        ) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation query date range.", {
            from: parsed.data.from,
            to: parsed.data.to,
          });
        }

        const filters = {
          submissionId: parsed.data.submissionId,
          statuses: parseStatuses(parsed.data.status),
          createdFrom: fromDate?.toISOString(),
          createdTo: toDate?.toISOString(),
        };
        return c.json(
          (await listManagementSubmissions(c.env.DB, {
            ...filters,
            mode: parsed.data.mode,
            offset: parsed.data.offset,
            limit: parsed.data.limit,
          })) satisfies z.output<typeof docs.managementPageSchema>,
        );
      },
    )
    .get(
      "/images/coverage",
      operation("getImageCoverage", "Moderation", "Read image coverage", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Administrator role and unlocked moderation required.",
        query: docs.imageCoverageQuerySchema,
        response: docs.imageCoverageResponseSchema,
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
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
          (await getImageCoverage(c.env.DB, {
            scope: requestedScope,
            imageScope: resolveImageScope("", requestedScope),
          })) satisfies z.output<typeof docs.imageCoverageResponseSchema>,
        );
      },
    )
    .get(
      "/images/orphans",
      operation("getOrphanImages", "Moderation", "Read orphan image objects", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Administrator role and unlocked moderation required.",
        response: docs.orphanImagesResponseSchema,
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
        const config = getRuntimeConfig(c.env);
        return c.json(
          (await getOrphanImages({
            db: c.env.DB,
            bucket: c.env.UGC_BUCKET,
            assetBaseUrl: config.ugcAssetBaseUrl,
          })) satisfies z.output<typeof docs.orphanImagesResponseSchema>,
        );
      },
    )
    .get(
      "/images/duplicates",
      operation("listDuplicateImageMarkers", "Moderation", "List markers with duplicate images", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Reviewer or administrator role and unlocked moderation required.",
        query: docs.duplicateImagesQuerySchema,
        response: docs.duplicateMarkersResponseSchema,
      }),
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
        } satisfies z.output<typeof docs.duplicateMarkersResponseSchema>);
      },
    )
    .get(
      "/images/duplicates/:markerId",
      operation("listDuplicateMarkerImages", "Moderation", "List duplicate images on a marker", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Reviewer or administrator role and unlocked moderation required.",
        query: docs.duplicateMarkerImagesQuerySchema,
        response: docs.duplicateImagesResponseSchema,
      }),
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
        } satisfies z.output<typeof docs.duplicateImagesResponseSchema>);
      },
    )
    .patch(
      "/:id/status",
      operation("updateModerationStatus", "Moderation", "Apply a management action", {
        errors: [404, 409, 429, 503],
        security: sessionSecurity,
        description: "Reviewer or administrator role and unlocked moderation required.",
        body: docs.updateSchema,
        response: docs.moderationUpdatedSchema,
      }),
      requireAuth,
      requireRole(["p", "a"]),
      rateLimit("auth"),
      async (c) => {
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

        const result = await applyManualModeration(
          {
            bindings: c.env,
            defer: (task) => c.executionCtx.waitUntil(task),
          },
          {
            actor: c.get("authUser"),
            submissionId,
            command: parsed.data,
          },
        );

        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.moderationUpdatedSchema
        >);
      },
    )
    .post(
      "/run",
      operation(
        "runModeration",
        "Moderation",
        "Moderate selected submissions or enqueue pending work",
        {
          errors: [429, 503],
          security: sessionSecurity,
          description: "Administrator role and unlocked moderation required.",
          body: docs.runSchema,
          response: docs.moderationRunSchema,
        },
      ),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
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
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.moderationRunSchema>);
      },
    )
    .post(
      "/run-once",
      operation("runModerationOnce", "Moderation", "Enqueue one moderation batch", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Administrator role and unlocked moderation required.",
        response: docs.moderationRunSchema,
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
        const result = await runAutoModerationRequest(c.env, { limit: 5 });
        return c.json({ ok: true, ...result } satisfies z.output<typeof docs.moderationRunSchema>);
      },
    )
    .post(
      "/karma/run-once",
      operation("runKarmaEvaluation", "Moderation", "Run karma evaluation", {
        errors: [429, 503],
        security: sessionSecurity,
        description: "Administrator role and unlocked moderation required.",
        response: docs.karmaRunSchema,
      }),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
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
        } satisfies z.output<typeof docs.karmaRunSchema>);
      },
    )
    .delete(
      "/test-images",
      operation(
        "archiveTestImages",
        "Moderation",
        "Archive test images and retain stored objects",
        {
          errors: [409, 429, 503],
          security: sessionSecurity,
          description: "Administrator role and unlocked moderation required.",
          response: docs.archiveTestImagesSchema,
        },
      ),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async (c) => {
        const config = getRuntimeConfig(c.env);
        const prefix = config.ugcUploadPathPrefix || "_test";
        if (prefix !== "_test") {
          throw new ApiError(
            409,
            "TEST_PREFIX_DISABLED",
            "Test image cleanup is only available for the _test prefix.",
          );
        }

        const archived = await archiveTestImageSubmissions(c.env.DB, {
          prefix,
          adminUserId: c.get("authUser").uid,
        });
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
        } satisfies z.output<typeof docs.archiveTestImagesSchema>);
      },
    )
    .delete(
      "/stale",
      operation(
        "deleteStaleSubmissions",
        "Moderation",
        "Report the append-only retention restriction",
        {
          errors: [429, 503],
          security: sessionSecurity,
          description: "Administrator role and unlocked moderation required.",
          responses: {
            409: jsonResponse(
              apiErrorSchema,
              "Stale content is retained; use management actions instead",
            ),
          },
        },
      ),
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
      async () => {
        throw new ApiError(
          409,
          "APPEND_ONLY_RETENTION",
          "Stale submissions and their R2 objects are retained. Update status instead of deleting records.",
        );
      },
    );
}
