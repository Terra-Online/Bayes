import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

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
    .get("/submissions", async (c) => {
      const parsed = adminListSchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid submission query.");
      }
      return c.json(
        await listManagementSubmissions(c.env.DB, {
          ...parsed.data,
          deleted: parsed.data.deleted === undefined ? undefined : parsed.data.deleted === "true",
        }),
      );
    })
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
    .get("/submissions/:id", async (c) => {
      const result = await listManagementSubmissions(c.env.DB, { submissionId: c.req.param("id") });
      if (!result.items.length) {
        throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
      }
      return c.json({ item: result.items[0] });
    })
    .get("/submissions/:id/history", async (c) => {
      const parsed = historySchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid history query.");
      }
      return c.json(
        await listSubmissionHistory(c.env.DB, {
          ...parsed.data,
          submissionId: c.req.param("id"),
          cursor: parseCursor(parsed.data.cursor),
        }),
      );
    })
    .get("/submissions/:id/reports/history", async (c) => {
      const parsed = historySchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid report history query.");
      }
      return c.json(
        await listSubmissionHistory(c.env.DB, {
          ...parsed.data,
          reportsOnly: true,
          submissionId: c.req.param("id"),
          cursor: parseCursor(parsed.data.cursor),
        }),
      );
    })
    .get("/submissions/:id/snapshots", async (c) => {
      const parsed = snapshotPageSchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ApiError(422, "VALIDATION_ERROR", "Invalid snapshot query.");
      }
      return c.json(
        await listHistoricalSnapshots(c.env.DB, {
          ...parsed.data,
          submissionId: c.req.param("id"),
        }),
      );
    })
    .get("/submissions/:id/snapshots/:snapshotId/file", async (c) => {
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
    })
    .post("/submissions/:id/revisions", async (c) => {
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
      return c.json({ ok: true, ...result });
    })
    .patch("/submissions/:id/snapshots/:snapshotId/review", async (c) => {
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
      return c.json({ ok: true, ...result });
    })
    .post("/submissions/:id/delete", async (c) => {
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
      return c.json({ ok: true, ...result });
    })
    .post("/submissions/:id/restore", async (c) => {
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
      return c.json({ ok: true, ...result });
    });
}
