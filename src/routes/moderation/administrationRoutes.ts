import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";

import { ApiError } from "@/lib/errors";
import { requireAuth, requireRole } from "@/middleware/auth";
import { rateLimit } from "@/middleware/rate-limit";
import {
  listSubmissionHistory,
  listHistoricalSnapshots,
  getHistoricalImage,
  submissionExists,
  type HistoryCursor,
} from "@/repositories/submission/history";
import { listManagementSubmissions } from "@/repositories/submission/managementReads";
import { operation, sessionSecurity } from "@/routes/openapi/operation";
import * as docs from "@/routes/schema/moderation";
import {
  deletionSchema,
  deleteSchema,
  correctionSchema,
  revisionSchema,
  historySchema,
  cursorSchema,
  snapshotPageSchema,
  adminListSchema,
} from "@/routes/schema/moderation";
import {
  administerDeletion,
  administerReview,
  administerRevision,
} from "@/services/moderation/administration";
import type { AppEnv } from "@/types/app";

import { requireModerationUnlocked } from "./lock";

function parseCursor(raw: string | undefined): HistoryCursor | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return cursorSchema.parse(JSON.parse(atob(raw)));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid history cursor.");
  }
}

export function createRoutes() {
  return new Hono<AppEnv>()
    .use(
      "/submissions/*",
      requireModerationUnlocked,
      requireAuth,
      requireRole(["a"]),
      rateLimit("auth"),
    )
    .get(
      "/submissions",
      operation("listAdminSubmissions", "Moderation", "List retained submissions", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Administrator access required. Filters include current deletion and review state.",
        query: adminListSchema,
        response: docs.managementPageSchema,
      }),
      async (c) => {
        const parsed = adminListSchema.safeParse(c.req.query());
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid submission query.");
        }
        return c.json(
          (await listManagementSubmissions(c.env.DB, {
            ...parsed.data,
            deleted: parsed.data.deleted === undefined ? undefined : parsed.data.deleted === "true",
          })) satisfies z.output<typeof docs.managementPageSchema>,
        );
      },
    )
    .use(
      "/submissions/:id/*",
      createMiddleware<AppEnv>(async (c, next) => {
        c.header("Cache-Control", "private, no-store");
        const exists = await submissionExists(c.env.DB, c.req.param("id")!);
        if (!exists) {
          throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
        }
        await next();
      }),
    )
    .get(
      "/submissions/:id",
      operation("getAdminSubmission", "Moderation", "Inspect a retained submission", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Includes frontier, public snapshot, deletion facts, lifecycleVersion and snapshot reviewVersion.",
        response: docs.managementItemSchema,
      }),
      async (c) => {
        const result = await listManagementSubmissions(c.env.DB, {
          submissionId: c.req.param("id"),
        });
        if (!result.items.length) {
          throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
        }
        return c.json({ item: result.items[0] } satisfies z.output<
          typeof docs.managementItemSchema
        >);
      },
    )
    .get(
      "/submissions/:id/history",
      operation("getSubmissionHistory", "Moderation", "Read retained submission history", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Creation, lifecycle, review and report events. Missing older history does not imply no action occurred.",
        query: historySchema,
        response: docs.historyResponseSchema,
      }),
      async (c) => {
        const parsed = historySchema.safeParse(c.req.query());
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid history query.");
        }
        return c.json(
          (await listSubmissionHistory(c.env.DB, {
            ...parsed.data,
            submissionId: c.req.param("id"),
            cursor: parseCursor(parsed.data.cursor),
          })) satisfies z.output<typeof docs.historyResponseSchema>,
        );
      },
    )
    .get(
      "/submissions/:id/reports/history",
      operation("getSubmissionReportHistory", "Moderation", "Read retained report history", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Filter by reporterUserId if needed. Reports and history survive deletion and revision.",
        query: historySchema,
        response: docs.historyResponseSchema,
      }),
      async (c) => {
        const parsed = historySchema.safeParse(c.req.query());
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid report history query.");
        }
        return c.json(
          (await listSubmissionHistory(c.env.DB, {
            ...parsed.data,
            reportsOnly: true,
            submissionId: c.req.param("id"),
            cursor: parseCursor(parsed.data.cursor),
          })) satisfies z.output<typeof docs.historyResponseSchema>,
        );
      },
    )
    .get(
      "/submissions/:id/snapshots",
      operation("listHistoricalSnapshots", "Moderation", "List retained snapshots", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description: "Newest revision first. Use nextBeforeRevision for the next page.",
        query: snapshotPageSchema,
        response: docs.snapshotPageResponseSchema,
      }),
      async (c) => {
        const parsed = snapshotPageSchema.safeParse(c.req.query());
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid snapshot query.");
        }
        return c.json(
          (await listHistoricalSnapshots(c.env.DB, {
            ...parsed.data,
            submissionId: c.req.param("id"),
          })) satisfies z.output<typeof docs.snapshotPageResponseSchema>,
        );
      },
    )
    .get(
      "/submissions/:id/snapshots/:snapshotId/file",
      operation("getHistoricalImage", "Moderation", "Read historical image bytes", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description: "Administrator-only historical image access; private, no-store.",
        responses: {
          200: {
            description: "Private historical image; Content-Type follows the stored MIME type.",
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      }),
      async (c) => {
        const image = await getHistoricalImage(
          c.env.DB,
          c.req.param("id"),
          c.req.param("snapshotId"),
        );
        if (!image) {
          throw new ApiError(404, "IMAGE_NOT_FOUND", "Historical image not found.");
        }
        const object = await c.env.UGC_BUCKET.get(image.filePath);
        if (!object) {
          throw new ApiError(404, "IMAGE_NOT_FOUND", "Historical image not found.");
        }
        return new Response(object.body, {
          headers: {
            "Content-Type":
              object.httpMetadata?.contentType ?? image.mimeType ?? "application/octet-stream",
            "Cache-Control": "private, no-store",
          },
        });
      },
    )
    .post(
      "/submissions/:id/revisions",
      operation("appendAdminRevision", "Moderation", "Append a content correction", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Supply content or sourceSnapshotId from this submission. A changed baseline or pending frontier returns 409. Deleted content is not queued until restored; queue failure leaves the saved revision recoverable.",
        body: docs.revisionInputSchema,
        response: docs.revisionResponseSchema,
      }),
      async (c) => {
        const parsed = revisionSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Supply content or a source snapshot.");
        }
        const result = await administerRevision(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          {
            ...parsed.data,
            submissionId: c.req.param("id"),
            actorId: c.get("authUser").uid,
          },
        );
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.revisionResponseSchema
        >);
      },
    )
    .patch(
      "/submissions/:id/snapshots/:snapshotId/review",
      operation("correctSnapshotReview", "Moderation", "Correct a retained snapshot review", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Requires expectedReviewStatus and expectedReviewVersion. Does not reorder revisions, restore deletion, or award points or notifications.",
        body: correctionSchema,
        response: docs.reviewCorrectionResponseSchema,
      }),
      async (c) => {
        const parsed = correctionSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid review correction.");
        }
        const result = await administerReview(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          {
            ...parsed.data,
            submissionId: c.req.param("id"),
            snapshotId: c.req.param("snapshotId"),
            actorId: c.get("authUser").uid,
          },
        );
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.reviewCorrectionResponseSchema
        >);
      },
    )
    .post(
      "/submissions/:id/delete",
      operation("deleteAdminSubmission", "Moderation", "Delete a submission", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Requires the inspected frontier and lifecycle version. Retains content and reports. A stale precondition returns 409; a no-op adds no audit.",
        body: deleteSchema,
        response: docs.lifecycleResponseSchema,
      }),
      async (c) => {
        const parsed = deleteSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid deletion precondition.");
        }
        const result = await administerDeletion(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          {
            ...parsed.data,
            submissionId: c.req.param("id"),
            actorId: c.get("authUser").uid,
            action: "deleted",
          },
        );
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.lifecycleResponseSchema
        >);
      },
    )
    .post(
      "/submissions/:id/restore",
      operation("restoreAdminSubmission", "Moderation", "Restore a deleted submission", {
        errors: [404, 409, 422, 429, 503],
        security: sessionSecurity,
        description:
          "Requires the inspected lifecycle version. Restoration is independent of review and does not change points. Stale preconditions return 409.",
        body: deletionSchema,
        response: docs.lifecycleResponseSchema,
      }),
      async (c) => {
        const parsed = deletionSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(422, "VALIDATION_ERROR", "Invalid restoration precondition.");
        }
        const result = await administerDeletion(
          { bindings: c.env, defer: (task) => c.executionCtx.waitUntil(task) },
          {
            ...parsed.data,
            submissionId: c.req.param("id"),
            actorId: c.get("authUser").uid,
            action: "restored",
          },
        );
        return c.json({ ok: true, ...result } satisfies z.output<
          typeof docs.lifecycleResponseSchema
        >);
      },
    );
}
