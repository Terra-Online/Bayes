import { Hono, type Context } from "hono";
import { z } from "zod";
import { getRuntimeConfig } from "../lib/config";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import { requireAuth, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  ALL_STATUSES,
  deleteSubmissionsByStatus,
  deleteSubmissionsByFilePathPrefix,
  getSubmissionFilePathsByStatus,
  getReviewSubmissions,
  getSubmissionById,
  updateSubmissionStatus,
  type SubmissionStatus
} from "../repositories/submissions";
import { applyUserPointsDelta } from "../repositories/users";
import { getModerationPointsDeltaWithDailyBackoff, markKarmaDirty } from "../services/karma";
import { ensureModerationBackfill, moderateSubmissionIds, moderateSubmissionOnce } from "../services/moderation";
import type { AppEnv } from "../types/app";

const updateSchema = z.object({
  status: z.enum(["pending_openai", "pending_audit", "active", "flagged", "remove_request", "stale"]),
  moderationNote: z.string().max(500).optional()
});

const listSchema = z.object({
  status: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const runSelectedSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500)
});

const runSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional()
});

const STATUS_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending_openai: ["pending_audit", "stale"],
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
    redis,
    surgeModeEnabled: config.surgeModeEnabled,
    surgeBackoffMultiplier: config.surgeBackoffMultiplier,
    skipAiModeration: config.skipAiModeration,
    localAutoApprove: config.localUploadAutoApprove
  };

  if (payload.ids && payload.ids.length > 0) {
    const processed = await moderateSubmissionIds(
      c.env.DB,
      options,
      payload.ids,
      25_000
    );

    return {
      ok: true,
      mode: "selected" as const,
      requested: payload.ids.length,
      processed
    };
  }

  const limit = payload.limit ?? 5;
  await ensureModerationBackfill(c.env.DB, redis, limit);
  const processed = await moderateSubmissionOnce(
    c.env.DB,
    redis,
    options,
    limit,
    25_000
  );

  return {
    ok: true,
    mode: "queue" as const,
    requested: limit,
    processed
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
      limit: c.req.query("limit")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid moderation query.", parsed.error.flatten());
    }

    const rows = await getReviewSubmissions(c.env.DB, {
      statuses: parseStatuses(parsed.data.status),
      limit: parsed.data.limit ?? 100
    });
    return c.json({
      items: rows
    });
  });

  app.get("/statuses", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    return c.json({
      statuses: ALL_STATUSES,
      transitions: STATUS_TRANSITIONS
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
    if (current.status !== parsed.data.status && (parsed.data.status === "active" || parsed.data.status === "stale")) {
      const redis = createRedisClient(c.env);
      const config = getRuntimeConfig(c.env);
      await applyUserPointsDelta(
        c.env.DB,
        current.userId,
        await getModerationPointsDeltaWithDailyBackoff(redis, {
          userId: current.userId,
          kind: current.kind,
          status: parsed.data.status,
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
