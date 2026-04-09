import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getRuntimeConfig } from "../lib/config";
import { ApiError } from "../lib/errors";
import { createRedisClient } from "../lib/redis";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { createPendingSubmission } from "../repositories/submissions";
import { enqueueModeration } from "../services/moderation";
import { consumeUploadTicket, createUploadTicket } from "../services/upload";
import type { AppEnv } from "../types/app";

const presignSchema = z.object({
  markerId: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(64),
  content: z.string().max(1000).optional()
});

export function createUploadRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/presign", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const parsed = presignSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid presign payload.", parsed.error.flatten());
    }

    const config = getRuntimeConfig(c.env);
    const normalizedMime = parsed.data.mimeType.toLowerCase();
    if (!config.allowedUploadMime.has(normalizedMime)) {
      throw new ApiError(422, "MIME_NOT_ALLOWED", "File MIME type is not allowed.");
    }

    const redis = createRedisClient(c.env);
    const { ticketId, ticket } = await createUploadTicket(
      redis,
      {
        uid: user.uid,
        markerId: parsed.data.markerId,
        mimeType: normalizedMime,
        content: parsed.data.content
      },
      config.uploadUrlTtlSeconds
    );

    return c.json({
      ticketId,
      uploadUrl: `/uploads/v1/direct/${ticketId}`,
      expiresAt: ticket.expiresAt,
      objectKey: ticket.objectKey
    });
  });

  app.put("/direct/:ticketId", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const ticketId = c.req.param("ticketId");
    const redis = createRedisClient(c.env);
    const config = getRuntimeConfig(c.env);
    const ticket = await consumeUploadTicket(redis, ticketId);

    if (ticket.uid !== user.uid) {
      throw new ApiError(403, "UPLOAD_FORBIDDEN", "Upload ticket does not belong to current user.");
    }

    const incomingMime = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!incomingMime || incomingMime !== ticket.mimeType) {
      throw new ApiError(422, "MIME_MISMATCH", "Upload MIME type mismatch.");
    }

    const body = await c.req.arrayBuffer();
    if (body.byteLength <= 0 || body.byteLength > config.maxUploadBytes) {
      throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid.", {
        maxBytes: config.maxUploadBytes
      });
    }

    await c.env.UGC_BUCKET.put(ticket.objectKey, body, {
      httpMetadata: {
        contentType: ticket.mimeType
      }
    });

    const submissionId = nanoid(18);
    await createPendingSubmission(c.env.DB, {
      id: submissionId,
      markerId: ticket.markerId,
      uid: user.uid,
      content: ticket.content,
      imageR2Key: ticket.objectKey
    });

    await enqueueModeration(redis, submissionId);

    return c.json({
      ok: true,
      submission: {
        id: submissionId,
        markerId: ticket.markerId,
        auditStatus: 0,
        imageKey: ticket.objectKey
      }
    });
  });

  return app;
}
