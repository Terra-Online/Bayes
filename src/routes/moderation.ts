import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import { requireAuth, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { getPendingSubmissions, updateSubmissionStatus } from "../repositories/submissions";
import { ensureModerationBackfill, moderateSubmissionOnce } from "../services/moderation";
import type { AppEnv } from "../types/app";

const updateSchema = z.object({
  auditStatus: z.union([z.literal(1), z.literal(2)]),
  moderationNote: z.string().max(500).optional()
});

export function createModerationRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/pending", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const rows = await getPendingSubmissions(c.env.DB, 50);
    return c.json({
      items: rows
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

    await updateSubmissionStatus(c.env.DB, {
      id: submissionId,
      auditStatus: parsed.data.auditStatus,
      moderationNote: parsed.data.moderationNote
    });

    return c.json({ ok: true });
  });

  app.post("/run-once", requireAuth, requireRole(["a"]), rateLimit("auth"), async (c) => {
    const redis = createRedisClient(c.env);
    await ensureModerationBackfill(c.env.DB, redis, 20);
    const processed = await moderateSubmissionOnce(c.env.DB, redis, c.env.OPENAI_API_KEY, 10);

    return c.json({
      ok: true,
      processed
    });
  });

  return app;
}
