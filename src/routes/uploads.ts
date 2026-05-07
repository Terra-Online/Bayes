import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getRuntimeConfig } from "../lib/config";
import { ApiError } from "../lib/errors";
import { requireAuth, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { createPendingSubmission, listActiveImagesByMarker } from "../repositories/submissions";
import { readImageDimensions } from "../services/image-metadata";
import { buildUploadObjectKey, extensionFromMime, normalizePathPart, prepareUploadImageForStorage } from "../services/upload";
import type { AppEnv } from "../types/app";

const imagesQuerySchema = z.object({
  markerId: z.string().min(1).max(128).optional(),
  markerIds: z.string().max(4000).optional(),
  scope: z.enum(["test", "prod"]).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional()
});

const imageUploadFieldsSchema = z.object({
  markerId: z.string().min(1).max(128),
  poiHash: z.string().min(1).max(128),
  poiType: z.string().min(1).max(128),
  content: z.string().max(1000).optional()
});

function isUploadsLocked(flag: string | undefined): boolean {
  const normalized = (flag ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function pickString(value: FormDataEntryValue | FormDataEntryValue[] | undefined): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === "string" ? item : undefined;
}

function pickFile(value: FormDataEntryValue | FormDataEntryValue[] | undefined): File | null {
  const item = Array.isArray(value) ? value[0] : value;
  return item instanceof File ? item : null;
}

function parseObjectKey(raw: string | undefined): string {
  const key = raw?.trim() ?? "";
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
  }
  return key;
}

function parseObjectKeyFromRequestPath(path: string): string {
  const marker = "/uploads/v1/file/";
  const localMarker = "/file/";
  const markerIndex = path.indexOf(marker);
  const raw = markerIndex >= 0
    ? path.slice(markerIndex + marker.length)
    : path.startsWith(localMarker)
      ? path.slice(localMarker.length)
      : "";

  try {
    return parseObjectKey(decodeURIComponent(raw));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid image path.");
  }
}

export function createUploadRoutes() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const isPublicImageRead = c.req.method === "GET" && c.req.path.endsWith("/uploads/v1/images");
    if (!isPublicImageRead && isUploadsLocked(c.env.LOCK_UPLOAD_ENDPOINTS)) {
      throw new ApiError(
        503,
        "UPLOADS_TEMPORARILY_DISABLED",
        "Upload endpoints are temporarily disabled during stabilization."
      );
    }
    await next();
  });

  app.post("/images", requireAuth, rateLimit("auth"), async (c) => {
    const user = c.get("authUser");
    if (!user) {
      throw new ApiError(401, "UNAUTHORIZED", "Session is invalid.");
    }

    const form = await c.req.parseBody();
    const file = pickFile(form.file) ?? pickFile(form.image);
    if (!file) {
      throw new ApiError(422, "UPLOAD_FILE_MISSING", "Image file is required.");
    }

    const parsed = imageUploadFieldsSchema.safeParse({
      markerId: pickString(form.markerId),
      poiHash: pickString(form.poiHash),
      poiType: pickString(form.poiType),
      content: pickString(form.content)
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid upload payload.", parsed.error.flatten());
    }

    const config = getRuntimeConfig(c.env);
    const normalizedMime = file.type.toLowerCase();
    if (!config.allowedUploadMime.has(normalizedMime) || extensionFromMime(normalizedMime) === "bin") {
      throw new ApiError(422, "MIME_NOT_ALLOWED", "File MIME type is not allowed.");
    }

    const body = await file.arrayBuffer();
    if (body.byteLength <= 0 || body.byteLength > config.maxUploadBytes) {
      throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid.", {
        maxBytes: config.maxUploadBytes
      });
    }

    const dimensions = readImageDimensions(body, normalizedMime);
    const preparedImage = await prepareUploadImageForStorage({
      body,
      mimeType: normalizedMime,
      dimensions
    }).catch((error) => {
      throw new ApiError(422, "IMAGE_PROCESSING_FAILED", "Image could not be processed.", {
        reason: error instanceof Error ? error.message : "unknown"
      });
    });
    if (preparedImage.sizeBytes <= 0 || preparedImage.sizeBytes > config.maxUploadBytes) {
      throw new ApiError(422, "UPLOAD_SIZE_INVALID", "Upload body size is invalid after processing.", {
        maxBytes: config.maxUploadBytes
      });
    }

    const submissionId = nanoid(18);
    const snapshotId = nanoid(12);
    const poiType = normalizePathPart(parsed.data.poiType);
    const poiHash = normalizePathPart(parsed.data.poiHash);
    const objectKey = buildUploadObjectKey({
      poiType,
      poiHash,
      snapshotId,
      mimeType: preparedImage.mimeType,
      prefix: config.ugcUploadPathPrefix
    });

    await c.env.UGC_BUCKET.put(objectKey, preparedImage.body, {
      httpMetadata: {
        contentType: preparedImage.mimeType
      },
      customMetadata: {
        sourceMimeType: normalizedMime,
        convertedToWebp: preparedImage.converted ? "true" : "false"
      }
    });

    await createPendingSubmission(c.env.DB, {
      id: submissionId,
      markerId: parsed.data.markerId,
      poiHash,
      poiType,
      snapshotId,
      userId: user.uid,
      content: parsed.data.content,
      filePath: objectKey,
      mimeType: preparedImage.mimeType,
      sizeBytes: preparedImage.sizeBytes,
      status: "pending_audit"
    });

    return c.json({
      ok: true,
      submission: {
        id: submissionId,
        markerId: parsed.data.markerId,
        status: "pending_audit",
        filePath: objectKey,
        snapshotId
      }
    });
  });

  app.get("/file/*", requireAuth, requireRole(["p", "a"]), rateLimit("auth"), async (c) => {
    const objectKey = parseObjectKeyFromRequestPath(c.req.path);
    const object = await c.env.UGC_BUCKET.get(objectKey);
    if (!object) {
      throw new ApiError(404, "IMAGE_NOT_FOUND", "Image file was not found.");
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "private, max-age=60");
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");

    return new Response(object.body, {
      status: 200,
      headers
    });
  });

  app.get("/images", rateLimit("public"), async (c) => {
    const parsed = imagesQuerySchema.safeParse({
      markerId: c.req.query("markerId"),
      markerIds: c.req.query("markerIds"),
      scope: c.req.query("scope"),
      limit: c.req.query("limit")
    });
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid image query.", parsed.error.flatten());
    }

    const markerIds = parsed.data.markerIds
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const ids = markerIds?.length ? markerIds : parsed.data.markerId ? [parsed.data.markerId] : [];
    if (ids.length === 0) {
      throw new ApiError(422, "VALIDATION_ERROR", "markerId or markerIds is required.");
    }

    const config = getRuntimeConfig(c.env);
    const pathPrefix = parsed.data.scope === "test" ? "_test" : undefined;
    const excludePathPrefix = parsed.data.scope === "prod" ? "_test" : undefined;
    const images = await listActiveImagesByMarker(c.env.DB, {
      markerIds: ids,
      assetBaseUrl: config.ugcAssetBaseUrl,
      pathPrefix,
      excludePathPrefix,
      limit: parsed.data.limit ?? 6
    });

    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ items: images });
  });

  return app;
}
